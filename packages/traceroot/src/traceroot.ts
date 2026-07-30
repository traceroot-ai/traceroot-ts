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
import { ContextIdGenerator, _resetTraceIdState, _setInternalMode } from './trace-id';

const DEFAULT_BASE_URL = 'https://app.traceroot.ai';

let _isInitialized = false;
let _tracingActive = false;
let _provider: NodeTracerProvider | undefined;
let _exportTarget: ExportTarget | undefined;

export interface ExportTarget {
  url: string;
  headers: Record<string, string>;
  internal: boolean;
}

/**
 * Resolve the OTLP export URL + headers. Public mode targets the public traces route
 * with Bearer auth; internal mode targets the bare baseUrl+path with the project id in
 * an X-Project-Id header (no Authorization; a caller-supplied X-Project-Id overrides
 * the option). SDK identity headers always win on collision with caller-supplied headers.
 */
export function resolveExportTarget(
  baseUrl: string,
  apiKey: string | undefined,
  sdkHeaders: Record<string, string>,
  internalExport: InitializeOptions['internalExport'],
): ExportTarget {
  if (internalExport) {
    // The OTLP exporter strips query strings from its endpoint URL, so the
    // project id travels as a header (the route accepts X-Project-Id).
    return {
      url: `${baseUrl}${internalExport.path}`,
      headers: {
        'X-Project-Id': internalExport.projectId,
        ...(internalExport.headers ?? {}),
        ...sdkHeaders,
      },
      internal: true,
    };
  }
  const headers = { ...sdkHeaders };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return { url: `${baseUrl}/api/v1/public/traces`, headers, internal: false };
}

/** @internal — the target resolved by the last initialize(); for tests only. */
export function _getExportTargetForTesting(): ExportTarget | undefined {
  return _exportTarget;
}

export class TraceRoot {
  private constructor() {}

  static isInitialized(): boolean {
    return _isInitialized;
  }

  /**
   * True only when initialize() completed AND this SDK's tracer provider actually won
   * the global OpenTelemetry registration. False when never initialized, after
   * shutdown(), or when another provider was already registered and ours was rejected
   * (spans flow elsewhere and trace-id forcing does not take effect). Lets callers
   * detect a lost registration directly instead of probing span behavior.
   */
  static isTracingActive(): boolean {
    return _isInitialized && _tracingActive;
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

    if (options.internalExport && !options.internalExport.path.startsWith('/')) {
      throw new TypeError(
        `[TraceRoot] internalExport.path must start with '/', got: ${JSON.stringify(options.internalExport.path)}`,
      );
    }

    const apiKey = options.apiKey ?? process.env['TRACEROOT_API_KEY'];
    if (!apiKey && !options.internalExport) {
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

    const sdkHeaders: Record<string, string> = {
      'x-traceroot-sdk-name': SDK_NAME,
      'x-traceroot-sdk-version': SDK_VERSION,
    };
    const target = resolveExportTarget(baseUrl, apiKey, sdkHeaders, options.internalExport);

    const exporter = new OTLPTraceExporter({
      url: target.url,
      headers: target.headers,
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

    _provider = new NodeTracerProvider(
      target.internal ? { idGenerator: new ContextIdGenerator() } : {},
    );
    _provider.addSpanProcessor(
      new TraceRootSpanProcessor(innerProcessor, {
        environment,
        gitRepo,
        gitRef,
        globalAttributes: options.globalAttributes,
      }),
    );
    _provider.register();

    // register() calls trace.setGlobalTracerProvider() internally, which is a no-op
    // (logs via diag, returns false — never throws) if another OTel provider was
    // already registered. Detect that by checking whether our provider actually became
    // the global delegate: if not, spans flow through the other provider and trace-id
    // forcing silently does nothing. Surface it loudly and record it for isTracingActive().
    const globalProvider = trace.getTracerProvider();
    const delegate =
      'getDelegate' in globalProvider &&
      typeof (globalProvider as { getDelegate: () => unknown }).getDelegate === 'function'
        ? (globalProvider as { getDelegate: () => unknown }).getDelegate()
        : globalProvider;
    _tracingActive = delegate === _provider;
    if (!_tracingActive) {
      console.error(
        '[TraceRoot] tracer-provider registration was rejected: another OpenTelemetry ' +
          'provider is already registered globally (registered before TraceRoot.initialize()). ' +
          'Spans flow through that provider and trace-id forcing will not take effect. ' +
          'Initialize TraceRoot before any other OpenTelemetry SDK.',
      );
    }

    // Wire instrumentations under a rollback guard: if this throws, the global is
    // already taken by our provider but the init did not complete. Undo the
    // registration and drop the provider so the NEXT initialize() starts clean —
    // otherwise it would build a second provider whose register() loses to this one,
    // leaving flush()/shutdown() operating on a provider that never received spans
    // (silent data loss).
    try {
      wireInstrumentations(options.instrumentModules);
    } catch (err) {
      trace.disable();
      context.disable();
      propagation.disable();
      void _provider.shutdown().catch(() => {});
      _provider = undefined;
      _tracingActive = false;
      throw err;
    }

    // Flip trusted-mode state only now that every fallible step above has
    // succeeded — a failed init must not leave forced-trace-id behavior
    // (or a stale _exportTarget) enabled while isInitialized() is false.
    _exportTarget = target;
    _setInternalMode(target.internal);
    _isInitialized = true;
    process.once('beforeExit', () => {
      void _provider?.forceFlush();
    });
  }

  /**
   * Flush buffered spans to the exporter. In batched mode (the default) this rejects
   * if an in-flight export failed (e.g. the ingest route returned an error status) —
   * callers whose work must never fail on a bad emit should catch the rejection
   * themselves. With `disableBatch` the simple processor routes export failures to
   * the OTel global error handler instead, and flush() resolves.
   */
  static async flush(): Promise<void> {
    await _provider?.forceFlush();
  }

  static async shutdown(): Promise<void> {
    try {
      await _provider?.shutdown();
    } finally {
      // Reset even when shutdown() rejects (e.g. a flush failure) — otherwise
      // the SDK is left claiming to be initialized with internal mode still on.
      _isInitialized = false;
      _tracingActive = false;
      _provider = undefined;
      _exportTarget = undefined;
      _setInternalMode(false);
      _resetObserveState();

      // Release the global tracer/context/propagation registration so a later
      // initialize() re-registers cleanly instead of losing to this dead provider.
      trace.disable();
      context.disable();
      propagation.disable();
    }
  }
}

/** @internal */
export function _resetForTesting(): void {
  _isInitialized = false;
  _tracingActive = false;
  _provider = undefined;
  _exportTarget = undefined;
  _setInternalMode(false);
  _resetTraceIdState();
  _resetObserveState();
  _resetGitContextCache();
  trace.disable();
  context.disable();
  propagation.disable();
}
