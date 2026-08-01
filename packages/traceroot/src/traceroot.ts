// src/traceroot.ts
import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  propagation,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  OpenInferenceBatchSpanProcessor,
  OpenInferenceSimpleSpanProcessor,
} from '@arizeai/openinference-vercel';
import { InitializeOptions } from './types';
import { SDK_NAME, SDK_VERSION, TraceRootSpanProcessor } from './processor';
import { wireInstrumentations } from './instrumentation';
import { DEFAULT_FLUSH_AT, DEFAULT_FLUSH_INTERVAL_SEC, DEFAULT_TIMEOUT_SEC } from './constants';
import { _resetObserveState } from './observe';
import {
  autoDetectGitContext,
  getGitRoot,
  harvestCiGitContext,
  gitContextFromFiles,
  _resetGitContextCache,
} from './git_context';

const DEFAULT_BASE_URL = 'https://app.traceroot.ai';

let _isInitialized = false;
let _provider: NodeTracerProvider | undefined;
// Resolved on initialize() so the offline-eval module can reach the same credentials
// (parity with the Python client that eval's _resolve_credentials reads).
let _apiKey: string | undefined;
// Left undefined until initialize() so an offline-eval call made before init still honors the
// TRACEROOT_HOST_URL env fallback (a hard default here would silently route to the default host).
let _baseUrl: string | undefined;

export class TraceRoot {
  private constructor() {}

  static isInitialized(): boolean {
    return _isInitialized;
  }

  /**
   * Resolve eval credentials with the same precedence the client uses: an explicit
   * argument wins, else the value resolved at initialize(), else the env var, else the
   * default host. Returns an empty apiKey when none is set (callers degrade to local).
   */
  static resolveCredentials(
    apiKey?: string,
    baseUrl?: string,
  ): { apiKey: string; baseUrl: string } {
    return {
      apiKey: apiKey ?? _apiKey ?? process.env['TRACEROOT_API_KEY'] ?? '',
      baseUrl: (
        baseUrl ??
        _baseUrl ??
        process.env['TRACEROOT_HOST_URL'] ??
        DEFAULT_BASE_URL
      ).replace(/\/$/, ''),
    };
  }

  static initialize(options: InitializeOptions = {}): void {
    const enabled = options.enabled ?? process.env['TRACEROOT_ENABLED'] !== 'false';
    if (!enabled) {
      return;
    }

    if (_isInitialized) {
      console.warn('[TraceRoot] Already initialized. Skipping duplicate initialize() call.');
      return;
    }

    const apiKey = options.apiKey ?? process.env['TRACEROOT_API_KEY'];
    if (!apiKey) {
      console.warn(
        '[TraceRoot] No API key provided. Set TRACEROOT_API_KEY env var or pass apiKey to initialize(). ' +
          'Spans will be emitted but export will fail.',
      );
    }

    const logLevelMap: Record<string, DiagLogLevel> = {
      debug: DiagLogLevel.DEBUG,
      info: DiagLogLevel.INFO,
      warn: DiagLogLevel.WARN,
      error: DiagLogLevel.ERROR,
    };
    diag.setLogger(
      new DiagConsoleLogger(),
      logLevelMap[options.logLevel ?? 'error'] ?? DiagLogLevel.ERROR,
    );

    const baseUrl = (
      options.baseUrl ??
      process.env['TRACEROOT_HOST_URL'] ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, '');

    // Expose to the offline-eval module (pull/report reuse the same credentials).
    _apiKey = apiKey;
    _baseUrl = baseUrl;

    const headers: Record<string, string> = {
      'x-traceroot-sdk-name': SDK_NAME,
      'x-traceroot-sdk-version': SDK_VERSION,
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const exporter = new OTLPTraceExporter({
      url: `${baseUrl}/api/v1/public/traces`,
      headers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compression: 'gzip' as any,
    });

    const environment = options.environment ?? process.env['TRACEROOT_ENVIRONMENT'];

    // `|| undefined` so an empty option/env var ('') is treated as unset —
    // otherwise it would block fallback detection and suppress the warning.
    let gitRepo = options.gitRepo || process.env['TRACEROOT_GIT_REPO'] || undefined;
    let gitRef = options.gitRef || process.env['TRACEROOT_GIT_REF'] || undefined;

    // CI/platform env vars — production path (no .git needed).
    if (gitRepo === undefined || gitRef === undefined) {
      const ci = harvestCiGitContext();
      gitRepo ??= ci.gitRepo;
      gitRef ??= ci.gitRef;
    }

    // .git read as files — dev fallback, no git binary required.
    if (gitRepo === undefined || gitRef === undefined) {
      const fromFiles = gitContextFromFiles();
      gitRepo ??= fromFiles.gitRepo;
      gitRef ??= fromFiles.gitRef;
    }

    // git subprocess — last resort (handles run-from-subdirectory).
    if (gitRepo === undefined || gitRef === undefined) {
      const autoGit = autoDetectGitContext();
      gitRepo ??= autoGit.gitRepo;
      gitRef ??= autoGit.gitRef;
    }

    // Warm git-root cache for per-span source paths (cached/idempotent).
    getGitRoot();

    // Honest absence: warn once, never fabricate.
    if (gitRepo === undefined || gitRef === undefined) {
      console.warn(
        '[TraceRoot] git context incomplete (repo=' +
          (gitRepo ?? 'unset') +
          ', ref=' +
          (gitRef ?? 'unset') +
          '). The AI agent needs both to correlate traces to source. ' +
          'Set TRACEROOT_GIT_REPO / TRACEROOT_GIT_REF (see ' +
          'https://docs.traceroot.ai/tracing/git-context).',
      );
    }

    // Flush/batch tuning — env vars take precedence over SDK defaults.
    const flushIntervalSec = Number(
      process.env['TRACEROOT_FLUSH_INTERVAL'] || DEFAULT_FLUSH_INTERVAL_SEC,
    );
    const flushAt = Number(process.env['TRACEROOT_FLUSH_AT'] || DEFAULT_FLUSH_AT);
    const timeoutSec = Number(process.env['TRACEROOT_TIMEOUT'] || DEFAULT_TIMEOUT_SEC);

    // ── Vercel AI SDK: wrap the exporter in OpenInference span processors ──────
    // These processors enrich spans emitted by Vercel AI SDK's experimental_telemetry
    // with OpenInference semantic conventions (model name, token counts, IO, etc.)
    // before they reach the OTLP exporter. All other SDK spans pass through unchanged.
    const innerProcessor = options.disableBatch
      ? new OpenInferenceSimpleSpanProcessor({ exporter })
      : new OpenInferenceBatchSpanProcessor({
          exporter,
          config: {
            scheduledDelayMillis: flushIntervalSec * 1000,
            maxExportBatchSize: flushAt,
            exportTimeoutMillis: timeoutSec * 1000,
          },
        });

    _provider = new NodeTracerProvider();
    _provider.addSpanProcessor(
      new TraceRootSpanProcessor(innerProcessor, { environment, gitRepo, gitRef }),
    );
    _provider.register();

    wireInstrumentations(options.instrumentModules);

    _isInitialized = true;
    process.once('beforeExit', () => {
      void _provider?.forceFlush();
    });
  }

  static async flush(): Promise<void> {
    await _provider?.forceFlush();
  }

  static async shutdown(): Promise<void> {
    await _provider?.shutdown();
    _isInitialized = false;
    _provider = undefined;
    _resetObserveState();
  }
}

/** @internal */
export function _resetForTesting(): void {
  _isInitialized = false;
  _provider = undefined;
  _resetObserveState();
  _resetGitContextCache();
  trace.disable();
  context.disable();
  propagation.disable();
}
