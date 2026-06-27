// LLM spans: one per turn_start -> turn_end. Token usage attaches from the
// assistant message_end. Model name comes from the live per-turn ctx.model,
// falling back to the last model_select only when the context omits it (model_select
// fires on interactive model changes, not on a CLI --model flag — verified empirically).
import { context, SpanKind, trace } from '@opentelemetry/api';
import { addEvent, setAttr } from '../attributes.ts';
import { IO_LIMITS, renderMessageContent } from '../content.ts';
import { safeJsonTruncate } from '../json.ts';
import type { LlmEntry } from '../state.ts';
import type { Runtime } from '../runtime.ts';
import type {
  AfterProviderResponseEvent,
  BeforeProviderRequestEvent,
  ExtensionContext,
  MessageEndEvent,
  ModelSelectEvent,
  TurnEndEvent,
  TurnStartEvent,
} from '../types.ts';

const PAYLOAD_MAX = 16384;

function requestMessages(payload: unknown): unknown[] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as { input?: unknown; messages?: unknown };
  if (Array.isArray(p.input)) return p.input;
  if (Array.isArray(p.messages)) return p.messages;
  return undefined;
}

// Prefer the live per-turn context; fall back to the last model_select only when
// the context omits the model (some run modes don't populate ctx.model). Reading
// the cache first would let a stale interactive selection shadow a later model.
export function resolveModel(
  rt: Runtime,
  ctx: ExtensionContext | undefined,
): { provider: string; id: string } | null {
  const m = ctx?.model;
  if (m?.provider && m?.id) return { provider: m.provider, id: m.id };
  if (rt.state.currentModel) return rt.state.currentModel;
  return null;
}

export function registerLlm(rt: Runtime): void {
  const { pi, state, config } = rt;

  const currentLlm = (): LlmEntry | undefined => {
    if (state.currentLlmTurnIndex === null) return undefined;
    return state.llmSpans.get(state.currentLlmTurnIndex);
  };

  pi.on('model_select', async (raw) => {
    const event = raw as ModelSelectEvent;
    if (event?.model?.provider && event?.model?.id) {
      state.currentModel = { provider: event.model.provider, id: event.model.id };
      rt.debug('model_select', state.currentModel);
    }
  });

  pi.on('thinking_level_select', async (raw) => {
    const level = (raw as { level?: string })?.level;
    state.thinkingLevel = typeof level === 'string' ? level : null;
    rt.debug('thinking_level', state.thinkingLevel);
  });

  pi.on('turn_start', async (raw, rawCtx) => {
    if (state.sessionDisabled) return;
    // No turn/session context means agent_start has not (re)opened the session span yet
    // — e.g. between a /traceroot enable and the next prompt. Opening an LLM span with no
    // parent would start a brand-new root trace and split the agent loop, so skip until
    // the session span exists (agent_start opens it and sets these contexts).
    const parentCtx = state.turnCtx ?? state.sessionCtx;
    if (!parentCtx) {
      rt.debug('turn_start with no session/turn context; skipping LLM span');
      return;
    }
    const event = raw as TurnStartEvent;
    const ctx = rawCtx as ExtensionContext;
    const model = resolveModel(rt, ctx);
    const label = model ? `${model.provider}/${model.id}` : 'unknown/unknown';

    const span = rt.tracer.startSpan(label, { kind: SpanKind.CLIENT }, parentCtx);
    const turnIndex = typeof event?.turnIndex === 'number' ? event.turnIndex : -1;
    setAttr(span, 'traceroot.pi.turn_index', turnIndex);
    if (model) {
      setAttr(span, 'gen_ai.system', model.provider);
      setAttr(span, 'gen_ai.request.model', model.id);
    }
    // Only stamp the level when one was actually selected. setAttr drops null, so an
    // unset level leaves the attribute absent rather than polluting every span with the
    // literal "unknown" (which is indistinguishable from a real level named "unknown").
    setAttr(span, 'gen_ai.request.thinking_level', state.thinkingLevel);

    // P2-C: context-window pressure, when the running mode exposes it.
    try {
      const usage = ctx?.getContextUsage?.();
      if (usage) {
        if (usage.tokens != null) setAttr(span, 'traceroot.pi.context_tokens', usage.tokens);
        if (usage.percent != null) setAttr(span, 'traceroot.pi.context_percentage', usage.percent);
      }
    } catch {
      /* getContextUsage not available in this mode */
    }

    const llmCtx = trace.setSpan(context.active(), span);
    // Defensive: if a prior turn_start used this index without a turn_end, end that
    // span before replacing it — otherwise overwriting the map entry evicts it and
    // its span leaks (sweepTurnScoped can no longer reach it). Mirrors tool.ts's
    // double-open guard, but ends-then-replaces rather than skipping.
    const stale = state.llmSpans.get(turnIndex);
    if (stale) {
      try {
        setAttr(stale.span, 'traceroot.pi.turn_incomplete', true);
        stale.span.end();
      } catch {
        /* best-effort */
      }
    }
    state.llmSpans.set(turnIndex, { span, ctx: llmCtx, startTime: Date.now(), turnIndex });
    state.currentLlmTurnIndex = turnIndex;
    rt.debug('opened LLM span turnIndex=', turnIndex, 'model=', label);
  });

  pi.on('message_end', async (raw) => {
    const event = raw as MessageEndEvent;
    const message = event?.message;
    if (!message || message.role !== 'assistant') return;

    const entry = currentLlm();
    if (!entry) return;

    const usage = message.usage;
    if (usage) {
      setAttr(entry.span, 'gen_ai.usage.input_tokens', usage.input ?? 0);
      setAttr(entry.span, 'gen_ai.usage.output_tokens', usage.output ?? 0);
      if (usage.cacheRead != null)
        setAttr(entry.span, 'gen_ai.usage.cache_read_input_tokens', usage.cacheRead);
      if (usage.cacheWrite != null)
        setAttr(entry.span, 'gen_ai.usage.cache_write_input_tokens', usage.cacheWrite);
      if (usage.totalTokens != null)
        setAttr(entry.span, 'traceroot.pi.total_tokens', usage.totalTokens);
      if (usage.cost?.total != null)
        setAttr(entry.span, 'traceroot.pi.cost_total', usage.cost.total);
    }
    if (message.stopReason != null)
      setAttr(entry.span, 'traceroot.pi.finish_reason', message.stopReason);

    // The assistant message is this LLM span's Output; cache it as the session output.
    const outputText = renderMessageContent(
      (message as { content?: unknown }).content,
      IO_LIMITS.llmOutput,
    );
    if (outputText) {
      setAttr(entry.span, 'traceroot.span.output', outputText);
      state.lastAssistantText = outputText;
    }
  });

  pi.on('turn_end', async (raw) => {
    const event = raw as TurnEndEvent;
    // Resolve to an actually-open LLM span. Prefer the event's index, but fall back
    // to the most-recently opened turn whenever that key is absent (payload omits a
    // numeric index, or its index disagrees with what turn_start stored) so a
    // turn_end never leaves its LLM span open.
    const eventIndex = typeof event?.turnIndex === 'number' ? event.turnIndex : null;
    const turnIndex =
      eventIndex !== null && state.llmSpans.has(eventIndex)
        ? eventIndex
        : state.currentLlmTurnIndex;
    if (turnIndex === null) return;
    const entry = state.llmSpans.get(turnIndex);
    if (!entry) return;
    // Delete first so a throw in end() cannot leak the entry (then mislabel it
    // turn_incomplete in the agent_end sweep). end() is best-effort.
    state.llmSpans.delete(turnIndex);
    if (state.currentLlmTurnIndex === turnIndex) state.currentLlmTurnIndex = null;
    try {
      entry.span.end();
    } catch {
      /* best-effort */
    }
    rt.debug('closed LLM span turnIndex=', turnIndex);
  });

  // P2-A — request messages as the LLM Input + message count; full payload opt-in.
  pi.on('before_provider_request', async (raw) => {
    const entry = currentLlm();
    if (!entry) return;
    const event = raw as BeforeProviderRequestEvent;
    const messages = requestMessages(event?.payload);
    if (messages) {
      // The message count is non-sensitive metadata; always record it.
      setAttr(entry.span, 'traceroot.pi.request_message_count', messages.length);
      // The request messages are the full prior conversation (system prompt, earlier
      // turns, tool results, file content) — high-PII content. Gate the Input panel
      // behind the same opt-in that governs full payloads; default is count-only.
      if (config.captureFullPayload) {
        setAttr(entry.span, 'traceroot.span.input', safeJsonTruncate(messages, IO_LIMITS.llmInput));
      }
    }
    if (config.captureFullPayload) {
      setAttr(
        entry.span,
        'traceroot.pi.full_request_payload',
        safeJsonTruncate(event?.payload, PAYLOAD_MAX),
      );
    }
  });

  // P2-B — HTTP status + rate-limit headers, plus error events.
  pi.on('after_provider_response', async (raw) => {
    const entry = currentLlm();
    if (!entry) return;
    const event = raw as AfterProviderResponseEvent;
    const status = event?.status;
    if (typeof status !== 'number') return;
    setAttr(entry.span, 'http.status_code', status);
    // Record rate-limit / retry-after headers as queryable attributes on every
    // response (not only at 429), so throttling is debuggable over time.
    const headers = event?.headers;
    if (headers) {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower.startsWith('x-ratelimit-') || lower === 'retry-after') {
          setAttr(entry.span, `traceroot.pi.${lower.replace(/-/g, '_')}`, headers[key]);
        }
      }
    }
    if (status === 429) {
      addEvent(entry.span, 'rate_limited', { 'http.retry_after': event?.headers?.['retry-after'] });
    } else if (status >= 500) {
      addEvent(entry.span, 'provider_error', { 'http.status_code': status });
    }
  });
}
