// src/usingAttributes.ts
import { context } from '@opentelemetry/api';
import { setMetadata, setSession, setTags, setUser } from '@arizeai/openinference-core';

export interface UsingAttributesOptions {
  /** Associate all spans in this block with a session / conversation ID. */
  sessionId?: string;
  /** Associate all spans in this block with a user. */
  userId?: string;
  /** Tag all spans in this block. */
  tags?: string[];
  /** Attach arbitrary metadata to all spans in this block. */
  metadata?: Record<string, unknown>;
}

/**
 * Runs `fn` in an OpenTelemetry context that carries the given OpenInference
 * attributes. Every span created inside `fn` — including those produced by
 * auto-instrumented libraries (OpenAI, Anthropic, LangChain, …) — inherits
 * sessionId, userId, tags, and metadata automatically.
 *
 * Spans created *before* entering this call are not retroactively updated.
 * `usingAttributes` calls can be nested; the innermost value for each field wins.
 *
 * @example
 * ```typescript
 * const answer = await usingAttributes(
 *   { sessionId: 'conv-123', userId: 'u-456', tags: ['prod'] },
 *   () => myPipeline.run(userMessage),
 * );
 * ```
 */
export async function usingAttributes<T>(
  attrs: UsingAttributesOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  let ctx = context.active();

  if (attrs.sessionId !== undefined) {
    ctx = setSession(ctx, { sessionId: attrs.sessionId });
  }
  if (attrs.userId !== undefined) {
    ctx = setUser(ctx, { userId: attrs.userId });
  }
  if (attrs.tags !== undefined) {
    ctx = setTags(ctx, attrs.tags);
  }
  if (attrs.metadata !== undefined) {
    ctx = setMetadata(ctx, attrs.metadata);
  }

  return context.with(ctx, () => Promise.resolve(fn()));
}
