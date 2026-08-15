// src/spans.ts — imperative span handle API
import { context, trace, SpanStatusCode, Span as OtelSpan, Tracer } from '@opentelemetry/api';
import { applyCommonAttributes, applyModel, applyUsage, applyIO, trySerialize } from './attributes';
import { SPAN_METADATA } from './constants';
import { StartSpanOptions, SpanUpdate } from './types';
import { TraceRoot } from './traceroot';

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  update(attrs: SpanUpdate): this;
  end(): void;
  startSpan(options: Omit<StartSpanOptions, 'parent'>): Span;
  setError(err: unknown): this;
}

class TracerootSpan implements Span {
  // `tracer` is the tracer that created this span; child spans reuse it so a subtree
  // stays on the same provider (e.g. the private, non-exporting eval provider).
  constructor(
    readonly otelSpan: OtelSpan,
    private readonly tracer?: Tracer,
  ) {}
  get spanId(): string {
    return this.otelSpan.spanContext().spanId;
  }
  get traceId(): string {
    return this.otelSpan.spanContext().traceId;
  }
  update(attrs: SpanUpdate): this {
    if (attrs.name !== undefined) this.otelSpan.updateName(attrs.name);
    applyIO(this.otelSpan, { input: attrs.input, output: attrs.output });
    if (attrs.metadata !== undefined) {
      const s = trySerialize(attrs.metadata);
      if (s !== undefined) this.otelSpan.setAttribute(SPAN_METADATA, s);
    }
    if (attrs.model !== undefined || attrs.modelParameters !== undefined) {
      applyModel(this.otelSpan, attrs.model, attrs.modelParameters);
    }
    if (attrs.usage !== undefined) applyUsage(this.otelSpan, attrs.usage);
    if (attrs.attributes !== undefined) this.otelSpan.setAttributes(attrs.attributes);
    return this;
  }
  end(): void {
    this.otelSpan.end();
  }
  startSpan(options: Omit<StartSpanOptions, 'parent'>): Span {
    return startSpan({ ...options, parent: this }, this.tracer);
  }
  setError(err: unknown): this {
    this.otelSpan.recordException(err instanceof Error ? err : new Error(String(err)));
    this.otelSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    return this;
  }
}

/** Wrap an existing OTel span (e.g. the active one) as a Span handle. */
export function wrapSpan(otel: OtelSpan): Span {
  return new TracerootSpan(otel);
}

let _tracer: ReturnType<typeof trace.getTracer> | undefined;
let _hasWarnedUninit = false;

// While > 0, startSpan()/observe() must NOT lazily initialize the global exporting
// provider. A local evaluation raises this for the duration of the run so that nested
// application spans (user startSpan/observe, auto-instrumentation) created during a
// local eval cannot bring up the OTLP exporter and leak to the network. It has no effect
// once the app has already initialized tracing itself (see the eval-tracer contract).
let _suppressGlobalAutoInitDepth = 0;
export function _pushSuppressGlobalAutoInit(): void {
  _suppressGlobalAutoInitDepth += 1;
}
export function _popSuppressGlobalAutoInit(): void {
  _suppressGlobalAutoInitDepth = Math.max(0, _suppressGlobalAutoInitDepth - 1);
}
export function _isGlobalAutoInitSuppressed(): boolean {
  return _suppressGlobalAutoInitDepth > 0;
}

export function startSpan(options: StartSpanOptions, tracerOverride?: Tracer): Span {
  // When a tracer is supplied (e.g. the eval engine's private, non-exporting tracer for
  // a local run), use it verbatim and do NOT touch the global exporting provider — this
  // is what keeps a local evaluation from initializing/exporting through the OTLP path.
  let tracer = tracerOverride;
  if (!tracer) {
    // Synchronous init guard — mirrors observe(). Unlike observe() (which is async
    // and can await a dynamic import), startSpan() is synchronous, so it must init
    // BEFORE creating the span or the first span would be dropped. initialize() is
    // synchronous and safe to call repeatedly.
    if (
      process.env['TRACEROOT_API_KEY'] &&
      !TraceRoot.isInitialized() &&
      _suppressGlobalAutoInitDepth === 0
    ) {
      TraceRoot.initialize();
    }
    _tracer ??= trace.getTracer('traceroot-ts');
    tracer = _tracer;
  }

  const parentOtel = options.parent ? (options.parent as TracerootSpan).otelSpan : undefined;
  const ctx = parentOtel ? trace.setSpan(context.active(), parentOtel) : context.active();

  const otel = tracer.startSpan(options.name, undefined, ctx);
  if (!otel.isRecording() && !_hasWarnedUninit) {
    _hasWarnedUninit = true;
    console.warn(
      '[TraceRoot] startSpan() called but TraceRoot.initialize() was not called. Spans will not be recorded.',
    );
  }
  if (otel.isRecording()) {
    applyCommonAttributes(
      otel,
      {
        type: options.type,
        metadata: options.metadata,
        tags: options.tags,
        sessionId: options.sessionId,
        userId: options.userId,
      },
      options.input !== undefined ? [options.input] : [],
    );
    if (options.model !== undefined || options.modelParameters !== undefined) {
      applyModel(otel, options.model, options.modelParameters);
    }
    if (options.attributes !== undefined) otel.setAttributes(options.attributes);
  }
  return new TracerootSpan(otel, tracerOverride);
}

/** Run fn with `span` as the active span so inner observe()/startSpan() nest under it. */
export function usingSpan<T>(span: Span, fn: () => T): T {
  const otel = (span as TracerootSpan).otelSpan;
  return context.with(trace.setSpan(context.active(), otel), fn);
}

/** @internal test reset */
export function _resetSpansState(): void {
  _tracer = undefined;
  _hasWarnedUninit = false;
}
