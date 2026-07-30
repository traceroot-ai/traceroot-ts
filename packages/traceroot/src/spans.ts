// src/spans.ts — imperative span handle API
import {
  context,
  Context,
  trace,
  SpanStatusCode,
  Span as OtelSpan,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import { applyCommonAttributes, applyModel, applyUsage, applyIO, trySerialize } from './attributes';
import { SPAN_METADATA } from './constants';
import { StartSpanOptions, SpanUpdate } from './types';
import { TraceRoot } from './traceroot';
import { shouldForceTraceId, warnIfForcingFailed, withForcedTraceId } from './trace-id';
import { contextWithoutProjectId, contextWithProjectId, shouldAttachProjectId } from './project-id';

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  update(attrs: SpanUpdate): this;
  end(): void;
  // traceId and projectId are excluded: a child handle always parents to `this`,
  // so forcing a trace id through it can never work, and the project id is
  // inherited from the root — reject both at the type level.
  startSpan(options: Omit<StartSpanOptions, 'parent' | 'traceId' | 'projectId'>): Span;
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
  startSpan(options: Omit<StartSpanOptions, 'parent' | 'traceId' | 'projectId'>): Span {
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
let _hasWarnedUninit = false;

export function startSpan(options: StartSpanOptions): Span {
  // Synchronous init guard — mirrors observe(). Unlike observe() (which is async
  // and can await a dynamic import), startSpan() is synchronous, so it must init
  // BEFORE creating the span or the first span would be dropped. initialize() is
  // synchronous and safe to call repeatedly.
  if (process.env['TRACEROOT_API_KEY'] && !TraceRoot.isInitialized()) {
    TraceRoot.initialize();
  }
  _tracer ??= trace.getTracer('traceroot-ts');

  if (options.traceId !== undefined && options.parent !== undefined) {
    throw new TypeError(
      '[TraceRoot] startSpan: traceId forces a new root and is mutually exclusive with parent.',
    );
  }
  if (options.projectId !== undefined && options.parent !== undefined) {
    throw new TypeError(
      '[TraceRoot] startSpan: projectId applies to a new root and is mutually exclusive with parent (children inherit it).',
    );
  }
  const tracer = _tracer;
  const forcedId = options.traceId;
  const attachedProjectId =
    options.projectId !== undefined && shouldAttachProjectId(options.projectId)
      ? options.projectId
      : undefined;
  const withProjectId = (base: Context): Context =>
    attachedProjectId !== undefined ? contextWithProjectId(base, attachedProjectId) : base;

  let otel: OtelSpan;
  if (forcedId !== undefined && shouldForceTraceId(forcedId)) {
    // ROOT_CONTEXT, not context.active(): an ambient active span would parent this
    // span and the generator would never be asked for a trace id.
    otel = withForcedTraceId(forcedId, () =>
      tracer.startSpan(options.name, undefined, withProjectId(ROOT_CONTEXT)),
    );
    warnIfForcingFailed(forcedId, otel);
  } else {
    const parentOtel = options.parent ? (options.parent as TracerootSpan).otelSpan : undefined;
    // Strip any ambient project id when parenting explicitly: a different root's
    // active scope must not leak onto this child — the processor's parent map
    // attributes it from the parent's own project id instead.
    const ctx = parentOtel
      ? contextWithoutProjectId(trace.setSpan(context.active(), parentOtel))
      : context.active();
    otel = tracer.startSpan(options.name, undefined, withProjectId(ctx));
  }
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
  _hasWarnedUninit = false;
}
