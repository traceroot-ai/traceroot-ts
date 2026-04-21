// src/processor.ts
import { trace as otelTrace, Context, Span } from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  ReadableSpan,
  SimpleSpanProcessor,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

export const SDK_NAME = 'traceroot-ts';
export const SDK_VERSION = version;

export interface TraceRootSpanProcessorOptions {
  environment?: string;
  gitRepo?: string;
  gitRef?: string;
}

/**
 * Wraps an inner SpanProcessor (Batch or Simple) and injects TraceRoot SDK
 * metadata attributes on every span start. This is the only processor TraceRoot
 * registers; the inner processor handles actual export batching.
 */
export class TraceRootSpanProcessor implements SpanProcessor {
  private readonly inner: BatchSpanProcessor | SimpleSpanProcessor;
  private readonly _environment: string | undefined;
  private readonly _gitRepo: string | undefined;
  private readonly _gitRef: string | undefined;
  // Keyed by spanId. Allows children to inherit paths even when the parent
  // is a NonRecordingSpan (remote context) with no attributes — which is
  // what OpenInference produces for LangGraph-instrumented node spans.
  private readonly _idsPathBySpanId = new Map<string, string[]>();
  private readonly _namePathBySpanId = new Map<string, string[]>();

  constructor(
    inner: BatchSpanProcessor | SimpleSpanProcessor,
    opts: TraceRootSpanProcessorOptions = {},
  ) {
    this.inner = inner;
    this._environment = opts.environment;
    this._gitRepo = opts.gitRepo;
    this._gitRef = opts.gitRef;
  }

  onStart(span: Span, parentContext: Context): void {
    span.setAttributes({
      'traceroot.sdk.name': SDK_NAME,
      'traceroot.sdk.version': SDK_VERSION,
    });
    if (this._environment !== undefined) {
      span.setAttribute('deployment.environment', this._environment);
    }
    if (this._gitRepo !== undefined) {
      span.setAttribute('traceroot.git.repo', this._gitRepo);
    }
    if (this._gitRef !== undefined) {
      span.setAttribute('traceroot.git.ref', this._gitRef);
    }

    // Enrich every span with its full name path from root to current span.
    // path[0] is always the root span name, so the backend can recover the
    // correct trace name even when child spans arrive before the root span.
    // Guard: a bare `{}` context (used in unit tests) has no getValue — skip gracefully.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentSpan = (
      typeof (parentContext as any)?.getValue === 'function'
        ? otelTrace.getSpan(parentContext)
        : undefined
    ) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanName = ((span as any).name as string) ?? '';

    // `span.name` and `span.parentSpanId` are not on the public @opentelemetry/api
    // Span interface but are stable internal fields on the SDK implementation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentSpanId: string | undefined =
      ((span as any).parentSpanId as string | undefined) ||
      (parentSpan?.spanContext?.()?.spanId as string | undefined);

    // Prefer the in-process map over span attributes: OpenInference creates
    // LangGraph node spans with a remote/NonRecordingSpan parent that carries
    // no attributes, so reading parentSpan.attributes would give undefined and
    // break the ancestry chain.
    const parentPath: string[] | undefined =
      (parentSpanId && this._namePathBySpanId.get(parentSpanId)) ||
      (parentSpan?.attributes?.['traceroot.span.path'] as string[] | undefined);
    const parentIdsPath: string[] | undefined =
      (parentSpanId && this._idsPathBySpanId.get(parentSpanId)) ||
      (parentSpan?.attributes?.['traceroot.span.ids_path'] as string[] | undefined);

    const spanPath: string[] = parentPath ? [...parentPath, spanName] : [spanName];
    // Gate on parentPath (not just parentSpanId) so path and ids_path stay in sync:
    // if path resolution failed (map miss + NonRecordingSpan), treat this span as a
    // root rather than emitting an inconsistent single-element path with a non-empty ids_path.
    const spanIdsPath: string[] =
      parentPath && parentSpanId
        ? parentIdsPath
          ? [...parentIdsPath, parentSpanId]
          : [parentSpanId]
        : [];

    span.setAttribute('traceroot.span.path', spanPath);
    span.setAttribute('traceroot.span.ids_path', spanIdsPath);

    // Store paths so descendant spans can inherit them via map lookup.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanId =
      typeof (span as any).spanContext === 'function' ? span.spanContext().spanId : undefined;
    if (spanId) {
      this._namePathBySpanId.set(spanId, spanPath);
      this._idsPathBySpanId.set(spanId, spanIdsPath);
    }

    // Cast required: inner processor expects the internal sdk-trace-base Span,
    // but the SpanProcessor interface uses the public @opentelemetry/api Span.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.inner.onStart(span as any, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    // Invariant: children must be started before their parent ends. A child span
    // started after onEnd runs here loses the map-based ancestry lookup for
    // NonRecordingSpan parents (no attribute fallback exists for those).
    const spanId = span.spanContext().spanId;
    this._idsPathBySpanId.delete(spanId);
    this._namePathBySpanId.delete(spanId);
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
