// Phase 2 enrichments. The LLM/response handlers attach attributes to the live
// LLM span; the compaction handlers open a short child span on the session for
// each context compaction.
import { SpanKind } from "@opentelemetry/api";
import { addEvent, setAttr } from "../attributes.ts";
import { safeJsonTruncate } from "../json.ts";
import { IO_LIMITS } from "../content.ts";
import type { LlmEntry, SpanState } from "../state.ts";
import type { Runtime } from "../runtime.ts";
import type {
  AfterProviderResponseEvent,
  BeforeProviderRequestEvent,
  SessionCompactEvent,
} from "../types.ts";

const PAYLOAD_MAX = 16384;

function currentLlm(state: SpanState): LlmEntry | undefined {
  if (state.currentLlmTurnIndex === null) return undefined;
  return state.llmSpans.get(state.currentLlmTurnIndex);
}

function requestMessages(payload: unknown): unknown[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as { input?: unknown; messages?: unknown };
  if (Array.isArray(p.input)) return p.input;
  if (Array.isArray(p.messages)) return p.messages;
  return undefined;
}

export function registerPhase2(rt: Runtime): void {
  const { pi, state, config } = rt;

  // P2-A — request messages as the LLM Input + message count; full payload opt-in.
  pi.on("before_provider_request", async (raw) => {
    const entry = currentLlm(state);
    if (!entry) return;
    const event = raw as BeforeProviderRequestEvent;
    const messages = requestMessages(event?.payload);
    if (messages) {
      setAttr(entry.span, "traceroot.pi.request_message_count", messages.length);
      // The messages sent to the model are this LLM span's Input panel.
      setAttr(entry.span, "traceroot.span.input", safeJsonTruncate(messages, IO_LIMITS.llmInput));
    }
    if (config.captureFullPayload) {
      setAttr(entry.span, "traceroot.pi.full_request_payload", safeJsonTruncate(event?.payload, PAYLOAD_MAX));
    }
  });

  // P2-B — HTTP status + rate-limit headers, plus error events.
  pi.on("after_provider_response", async (raw) => {
    const entry = currentLlm(state);
    if (!entry) return;
    const event = raw as AfterProviderResponseEvent;
    const status = event?.status;
    if (typeof status !== "number") return;
    setAttr(entry.span, "http.status_code", status);
    // Record rate-limit / retry-after headers as queryable attributes on every
    // response (not only at 429), so throttling is debuggable over time.
    const headers = event?.headers;
    if (headers) {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower.startsWith("x-ratelimit-") || lower === "retry-after") {
          setAttr(entry.span, `traceroot.pi.${lower.replace(/-/g, "_")}`, headers[key]);
        }
      }
    }
    if (status === 429) {
      addEvent(entry.span, "rate_limited", { "http.retry_after": event?.headers?.["retry-after"] });
    } else if (status >= 500) {
      addEvent(entry.span, "provider_error", { "http.status_code": status });
    }
  });

  // P2-C — compaction as a timed child span on the session.
  pi.on("session_before_compact", async () => {
    if (state.sessionDisabled || !state.sessionSpan || state.compactionSpan) return;
    state.compactionSpan = rt.tracer.startSpan(
      "pi.compaction",
      { kind: SpanKind.INTERNAL },
      state.sessionCtx ?? undefined,
    );
  });

  pi.on("session_compact", async (raw) => {
    const event = raw as SessionCompactEvent;
    const tokensBefore = event?.compactionEntry?.tokensBefore ?? 0;
    // Open lazily if before_compact never fired, so the compaction still records.
    let span = state.compactionSpan;
    if (!span) {
      if (!state.sessionSpan) return;
      span = rt.tracer.startSpan("pi.compaction", { kind: SpanKind.INTERNAL }, state.sessionCtx ?? undefined);
    }
    setAttr(span, "traceroot.pi.tokens_before", tokensBefore);
    span.end();
    state.compactionSpan = null;
  });
}
