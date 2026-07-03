// src/context.ts
import { trace } from '@opentelemetry/api';
import { SESSION_ID, USER_ID } from '@arizeai/openinference-semantic-conventions';
import { LLM_PROMPT, SPAN_METADATA, SPAN_TAGS, TRACE_METADATA } from './constants';
import { wrapSpan, type Span } from './spans';
import { applyUsage, applyModel, applyIO } from './attributes';
import type { TokenUsage } from './types';

/**
 * Sets attributes on the currently active span.
 * No-op when called outside an active span.
 *
 * LLM-specific attributes (model, modelParameters, usage, prompt) are useful
 * for instrumenting custom or unsupported LLM providers.
 */
export function updateCurrentSpan(attrs: {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  /** Rename the span after creation. */
  name?: string;
  /** LLM model name (e.g. 'gpt-4o', 'claude-3-opus'). */
  model?: string;
  /** LLM model parameters (e.g. { temperature: 0.7, max_tokens: 1024 }). */
  modelParameters?: Record<string, unknown>;
  /** Token usage (e.g. { input: 100, output: 50 }). */
  usage?: TokenUsage;
  /** Prompt / messages sent to the LLM. */
  prompt?: unknown;
  /** Arbitrary span attributes for keys the typed fields don't cover. */
  attributes?: Record<string, string | number | boolean>;
}): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  if (attrs.name !== undefined) {
    span.updateName(attrs.name);
  }
  applyIO(span, { input: attrs.input, output: attrs.output });
  if (attrs.metadata !== undefined) {
    try {
      span.setAttribute(SPAN_METADATA, JSON.stringify(attrs.metadata));
    } catch {
      /* non-serializable */
    }
  }
  if (attrs.model !== undefined || attrs.modelParameters !== undefined) {
    applyModel(span, attrs.model, attrs.modelParameters);
  }
  if (attrs.usage !== undefined) applyUsage(span, attrs.usage);
  if (attrs.prompt !== undefined) {
    try {
      span.setAttribute(LLM_PROMPT, JSON.stringify(attrs.prompt));
    } catch {
      /* non-serializable */
    }
  }
  if (attrs.attributes !== undefined) span.setAttributes(attrs.attributes);
}

/**
 * Sets trace-level association attributes (user, session, tags, metadata) on the
 * currently active span. No-op when called outside an active span.
 */
export function updateCurrentTrace(attrs: {
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  if (attrs.userId !== undefined) {
    span.setAttribute(USER_ID, attrs.userId);
  }
  if (attrs.sessionId !== undefined) {
    span.setAttribute(SESSION_ID, attrs.sessionId);
  }
  if (attrs.tags !== undefined) {
    try {
      span.setAttribute(SPAN_TAGS, JSON.stringify(attrs.tags));
    } catch {
      /* non-serializable */
    }
  }
  if (attrs.metadata !== undefined) {
    try {
      span.setAttribute(TRACE_METADATA, JSON.stringify(attrs.metadata));
    } catch {
      /* non-serializable */
    }
  }
}

/** The active span as a TraceRoot handle, or undefined outside a span. */
export function getCurrentSpan(): Span | undefined {
  const otel = trace.getActiveSpan();
  return otel ? wrapSpan(otel) : undefined;
}

function activeSpanContext() {
  const span = trace.getActiveSpan();
  return span ? span.spanContext() : undefined;
}

/**
 * Returns the trace ID of the currently active span, or undefined if no span is active.
 */
export function getCurrentTraceId(): string | undefined {
  return activeSpanContext()?.traceId;
}

/**
 * Returns the span ID of the currently active span, or undefined if no span is active.
 */
export function getCurrentSpanId(): string | undefined {
  return activeSpanContext()?.spanId;
}
