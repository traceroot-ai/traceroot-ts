// src/context.ts
import { trace } from '@opentelemetry/api';
import {
  INPUT_VALUE,
  OUTPUT_VALUE,
  SESSION_ID,
  USER_ID,
} from '@arizeai/openinference-semantic-conventions';
import { LLM_MODEL, LLM_MODEL_PARAMETERS, LLM_USAGE, LLM_PROMPT, SPAN_METADATA, SPAN_TAGS, TRACE_METADATA } from './constants';

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
  /** Token usage (e.g. { inputTokens: 100, outputTokens: 50 }). */
  usage?: Record<string, number>;
  /** Prompt / messages sent to the LLM. */
  prompt?: unknown;
}): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  if (attrs.name !== undefined) {
    span.updateName(attrs.name);
  }
  if (attrs.input !== undefined) {
    try { span.setAttribute(INPUT_VALUE, JSON.stringify(attrs.input)); } catch { /* non-serializable */ }
  }
  if (attrs.output !== undefined) {
    try { span.setAttribute(OUTPUT_VALUE, JSON.stringify(attrs.output)); } catch { /* non-serializable */ }
  }
  if (attrs.metadata !== undefined) {
    try { span.setAttribute(SPAN_METADATA, JSON.stringify(attrs.metadata)); } catch { /* non-serializable */ }
  }
  if (attrs.model !== undefined) {
    span.setAttribute(LLM_MODEL, attrs.model);
  }
  if (attrs.modelParameters !== undefined) {
    try { span.setAttribute(LLM_MODEL_PARAMETERS, JSON.stringify(attrs.modelParameters)); } catch { /* non-serializable */ }
  }
  if (attrs.usage !== undefined) {
    try { span.setAttribute(LLM_USAGE, JSON.stringify(attrs.usage)); } catch { /* non-serializable */ }
  }
  if (attrs.prompt !== undefined) {
    try { span.setAttribute(LLM_PROMPT, JSON.stringify(attrs.prompt)); } catch { /* non-serializable */ }
  }
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
    try { span.setAttribute(SPAN_TAGS, JSON.stringify(attrs.tags)); } catch { /* non-serializable */ }
  }
  if (attrs.metadata !== undefined) {
    try { span.setAttribute(TRACE_METADATA, JSON.stringify(attrs.metadata)); } catch { /* non-serializable */ }
  }
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
