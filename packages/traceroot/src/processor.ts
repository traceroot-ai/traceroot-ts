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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentSpan = otelTrace.getSpan(parentContext) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanName = ((span as any).name as string) ?? '';

    // ReadableSpan.parentSpanId is set by the SDK from the parent context at
    // span creation time, even when the parent is a remote span context and
    // getSpan() returns undefined. This is the reliable way to get the parent ID.
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
    const spanIdsPath: string[] = parentSpanId
      ? parentIdsPath
        ? [...parentIdsPath, parentSpanId]
        : [parentSpanId]
      : [];

    span.setAttribute('traceroot.span.path', spanPath);
    span.setAttribute('traceroot.span.ids_path', spanIdsPath);

    // Store paths so descendant spans can inherit them via map lookup.
    const spanId = span.spanContext().spanId;
    this._namePathBySpanId.set(spanId, spanPath);
    this._idsPathBySpanId.set(spanId, spanIdsPath);

    // Cast required: inner processor expects the internal sdk-trace-base Span,
    // but the SpanProcessor interface uses the public @opentelemetry/api Span.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.inner.onStart(span as any, parentContext);
  }

  onEnd(span: ReadableSpan): void {
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
