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
  _resetGitContextCache,
} from './git_context';

const DEFAULT_BASE_URL = 'https://app.traceroot.ai';

let _isInitialized = false;
let _provider: NodeTracerProvider | undefined;
let _warnedMissingGitContext = false;

// Avoid noisy logs when initialize() is retried without deploy-time git metadata.
function warnMissingGitContextOnce(): void {
  if (_warnedMissingGitContext) return;
  _warnedMissingGitContext = true;
  console.warn(
    '[TraceRoot] Git context could not be resolved. Set TRACEROOT_GIT_REPO and ' +
      'TRACEROOT_GIT_REF in production so traces can be correlated to source code. ' +
      'See https://docs.traceroot.ai/tracing/git-context',
  );
}

export class TraceRoot {
  private constructor() {}

  static isInitialized(): boolean {
    return _isInitialized;
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

    const gitRepoOverride = options.gitRepo ?? process.env['TRACEROOT_GIT_REPO'];
    const gitRefOverride = options.gitRef ?? process.env['TRACEROOT_GIT_REF'];
    let gitRepo = gitRepoOverride;
    let gitRef = gitRefOverride;

    // Production containers usually lack .git, so prefer CI/deploy metadata before local git.
    if (gitRepo === undefined || gitRef === undefined) {
      const ciGit = harvestCiGitContext();
      gitRepo ??= ciGit.gitRepo;
      gitRef ??= ciGit.gitRef;
    }

    // Local git detection remains the development fallback after explicit and env sources.
    if (gitRepo === undefined || gitRef === undefined) {
      const autoGit = autoDetectGitContext();
      gitRepo ??= autoGit.gitRepo;
      gitRef ??= autoGit.gitRef;
    } else {
      getGitRoot();
    }

    // Do not fabricate partial defaults; missing git context is omitted from spans.
    if (gitRepo === undefined && gitRef === undefined) {
      warnMissingGitContextOnce();
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
  _warnedMissingGitContext = false;
  _resetObserveState();
  _resetGitContextCache();
  trace.disable();
  context.disable();
  propagation.disable();
}
