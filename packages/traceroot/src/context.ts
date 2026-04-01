// src/context.ts
import { trace } from '@opentelemetry/api';
import {
  INPUT_VALUE,
  METADATA,
  OUTPUT_VALUE,
  SESSION_ID,
  TAG_TAGS,
  USER_ID,
} from '@arizeai/openinference-semantic-conventions';

/**
 * Sets input, output, or metadata attributes on the currently active span.
 * No-op when called outside an active span.
 */
export function updateCurrentSpan(attrs: {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
}): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  if (attrs.input !== undefined) {
    span.setAttribute(INPUT_VALUE, JSON.stringify(attrs.input));
  }
  if (attrs.output !== undefined) {
    span.setAttribute(OUTPUT_VALUE, JSON.stringify(attrs.output));
  }
  if (attrs.metadata !== undefined) {
    span.setAttribute(METADATA, JSON.stringify(attrs.metadata));
  }
}

/**
 * Sets trace-level association attributes (user, session, tags) on the
 * currently active span. No-op when called outside an active span.
 */
export function updateCurrentTrace(attrs: {
  userId?: string;
  sessionId?: string;
  tags?: string[];
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
    span.setAttribute(TAG_TAGS, JSON.stringify(attrs.tags));
  }
}
