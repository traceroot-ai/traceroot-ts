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
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InitializeOptions } from './types';
import { SDK_NAME, SDK_VERSION, TraceRootSpanProcessor } from './processor';
import { wireInstrumentations } from './instrumentation';
import { DEFAULT_FLUSH_AT, DEFAULT_FLUSH_INTERVAL_SEC, DEFAULT_TIMEOUT_SEC } from './constants';
import { _resetObserveState } from './observe';
import { autoDetectGitContext, getGitRoot, _resetGitContextCache } from './git_context';

const DEFAULT_BASE_URL = 'https://app.traceroot.ai';

let _isInitialized = false;
let _provider: NodeTracerProvider | undefined;

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
      // CompressionAlgorithm.GZIP = "gzip"; using string literal to avoid importing transitive dep
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compression: 'gzip' as any,
    });

    const environment = options.environment ?? process.env['TRACEROOT_ENVIRONMENT'];

    const gitRepoOverride = options.gitRepo ?? process.env['TRACEROOT_GIT_REPO'];
    const gitRefOverride = options.gitRef ?? process.env['TRACEROOT_GIT_REF'];
    let gitRepo = gitRepoOverride;
    let gitRef = gitRefOverride;
    if (gitRepo === undefined || gitRef === undefined) {
      const autoGit = autoDetectGitContext(); // also warms the git root cache
      gitRepo ??= autoGit.gitRepo;
      gitRef ??= autoGit.gitRef;
    } else {
      getGitRoot(); // warm git root cache for captureSourceLocation without shelling out for repo/ref
    }

    // Flush/batch tuning — env vars take precedence over SDK defaults.
    const flushIntervalSec = Number(
      process.env['TRACEROOT_FLUSH_INTERVAL'] || DEFAULT_FLUSH_INTERVAL_SEC,
    );
    const flushAt = Number(process.env['TRACEROOT_FLUSH_AT'] || DEFAULT_FLUSH_AT);
    const timeoutSec = Number(process.env['TRACEROOT_TIMEOUT'] || DEFAULT_TIMEOUT_SEC);

    const innerProcessor = options.disableBatch
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter, {
          scheduledDelayMillis: flushIntervalSec * 1000,
          maxExportBatchSize: flushAt,
          exportTimeoutMillis: timeoutSec * 1000,
        });

    _provider = new NodeTracerProvider();
    _provider.addSpanProcessor(
      new TraceRootSpanProcessor(innerProcessor, { environment, gitRepo, gitRef }),
    );
    _provider.register();

    wireInstrumentations(options.instrumentModules);

    _isInitialized = true;
    // forceFlush() is async and keeps the event loop alive via its HTTP export request,
    // so beforeExit + forceFlush() is sufficient — no keepAlive timer needed.
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
