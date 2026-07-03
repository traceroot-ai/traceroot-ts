// src/spans.ts — imperative span handle API
import { context, trace, SpanStatusCode, Span as OtelSpan } from '@opentelemetry/api';
import { applyCommonAttributes, applyModel, applyUsage, applyIO, trySerialize } from './attributes';
import { SPAN_METADATA } from './constants';
import { StartSpanOptions, SpanUpdate } from './types';

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  update(attrs: SpanUpdate): this;
  end(): void;
  startSpan(options: Omit<StartSpanOptions, 'parent'>): Span;
  setError(err: unknown): this;
}

class TracerootSpan implements Span {
  constructor(readonly otelSpan: OtelSpan) {}
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
    return startSpan({ ...options, parent: this });
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

export function startSpan(options: StartSpanOptions): Span {
  if (process.env['TRACEROOT_API_KEY']) {
    // Lazy sync init guard — mirrors observe(). Safe to call repeatedly.
    // (import kept dynamic to avoid a load-order cycle with traceroot.ts)
    void import('./traceroot').then(({ TraceRoot }) => {
      if (!TraceRoot.isInitialized()) TraceRoot.initialize();
    });
  }
  _tracer ??= trace.getTracer('traceroot-ts');

  const parentOtel = options.parent ? (options.parent as TracerootSpan).otelSpan : undefined;
  const ctx = parentOtel ? trace.setSpan(context.active(), parentOtel) : context.active();

  const otel = _tracer.startSpan(options.name, undefined, ctx);
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
  return new TracerootSpan(otel);
}

/** Run fn with `span` as the active span so inner observe()/startSpan() nest under it. */
export function usingSpan<T>(span: Span, fn: () => T): T {
  const otel = (span as TracerootSpan).otelSpan;
  return context.with(trace.setSpan(context.active(), otel), fn);
}

/** @internal test reset */
export function _resetSpansState(): void {
  _tracer = undefined;
}
