// Explicit span state. All mutable span bookkeeping lives here in one object —
// no module-level mutable state — so lifecycle and concurrency are auditable in
// one place. OTel context is threaded explicitly (never via AsyncLocalStorage),
// because pi events arrive sequentially from an event loop, not as nested calls.
import type { Context, Span } from "@opentelemetry/api";
import { setAttr } from "./attributes.ts";

export interface LlmEntry {
  span: Span;
  ctx: Context; // parent context for this turn's tool spans
  startTime: number;
  turnIndex: number;
}

export interface ToolEntry {
  span: Span;
  startTime: number;
  toolName: string;
}

export interface SpanState {
  sessionSpan: Span | null;
  sessionCtx: Context | null;
  sessionTraceId: string | null;
  sessionFile: string | null;
  sessionStartReason: string | null;

  turnSpan: Span | null;
  turnCtx: Context | null;
  promptIndex: number;
  pendingPrompt: string | null;

  // LLM spans keyed by turnIndex (one open per turn; map tolerates more).
  llmSpans: Map<number, LlmEntry>;
  currentLlmTurnIndex: number | null;

  // Tool spans keyed by toolCallId — parallel-safe, never a single "current tool".
  toolSpans: Map<string, ToolEntry>;

  currentModel: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  lastAssistantText: string | null;

  // Fork linking (P2-F): SpanContext of the session this one forked from.
  forkLink: { traceId: string; spanId: string } | null;
  forkedFromSessionFile: string | null;

  // The root {traceId, spanId} a reload/resume continues. New spans are parented
  // under it (the remote-parent Context is built on demand) so the trace survives
  // a reload — OTel cannot reopen the original span. Re-persisted unchanged so
  // repeated reloads stay siblings under the original root, not a deep chain.
  resumeFrom: { traceId: string; spanId: string } | null;

  // Buffered pi "input" event metadata, applied to the next turn span.
  pendingInput: { source?: string; streamingBehavior?: string; imageCount?: number; raw?: string } | null;

  // Open compaction span (session_before_compact -> session_compact).
  compactionSpan: Span | null;

  projectFinalized: boolean;
  sessionDisabled: boolean;
  // True once the single shared OTel provider has been shut down on a terminal quit.
  // Spans after this are no-ops; used so /traceroot flush can report accurately. Not a
  // per-session field — it is never reset by resetForNewSession.
  providerShutdown: boolean;
}

export function createSpanState(): SpanState {
  return {
    sessionSpan: null,
    sessionCtx: null,
    sessionTraceId: null,
    sessionFile: null,
    sessionStartReason: null,
    turnSpan: null,
    turnCtx: null,
    promptIndex: 0,
    pendingPrompt: null,
    llmSpans: new Map(),
    currentLlmTurnIndex: null,
    toolSpans: new Map(),
    currentModel: null,
    thinkingLevel: null,
    lastAssistantText: null,
    forkLink: null,
    forkedFromSessionFile: null,
    resumeFrom: null,
    pendingInput: null,
    compactionSpan: null,
    projectFinalized: false,
    sessionDisabled: false,
    providerShutdown: false,
  };
}

// Parent context for a tool span: the active LLM span, falling back to the turn,
// then the session. Returns undefined when nothing is open (caller skips the span).
export function activeParentCtx(state: SpanState): Context | undefined {
  if (state.currentLlmTurnIndex !== null) {
    const llm = state.llmSpans.get(state.currentLlmTurnIndex);
    if (llm) return llm.ctx;
  }
  return state.turnCtx ?? state.sessionCtx ?? undefined;
}

function endToolSpans(state: SpanState): void {
  for (const entry of state.toolSpans.values()) {
    try {
      setAttr(entry.span, "traceroot.pi.tool_incomplete", true);
      entry.span.end();
    } catch {
      /* best-effort */
    }
  }
  state.toolSpans.clear();
}

function endLlmSpans(state: SpanState): void {
  for (const entry of state.llmSpans.values()) {
    try {
      entry.span.end();
    } catch {
      /* best-effort */
    }
  }
  state.llmSpans.clear();
  state.currentLlmTurnIndex = null;
}

// Close turn-scoped spans (tools then LLM) left open at the end of an agent loop.
// In the happy path the maps are already empty (each turn_end / tool end closed
// its own span); this only matters when a turn or tool was aborted before its end
// event fired, so no entry ever leaks past agent_end.
export function sweepTurnScoped(state: SpanState): void {
  endToolSpans(state);
  endLlmSpans(state);
}

// Close every open span in reverse nesting order: tools -> LLM -> turn -> session.
// Used on session_shutdown so a hard exit (even mid-tool) never leaks an open span.
export function closeAllOpenSpans(state: SpanState, reason: string): void {
  sweepTurnScoped(state);

  if (state.compactionSpan) {
    try {
      state.compactionSpan.end();
    } catch {
      /* best-effort */
    }
    state.compactionSpan = null;
  }

  if (state.turnSpan) {
    try {
      state.turnSpan.end();
    } catch {
      /* best-effort */
    }
    state.turnSpan = null;
    state.turnCtx = null;
  }

  if (state.sessionSpan) {
    try {
      setAttr(state.sessionSpan, "traceroot.pi.shutdown_reason", reason);
      state.sessionSpan.end();
    } catch {
      /* best-effort */
    }
    state.sessionSpan = null;
    state.sessionCtx = null;
  }
}

// Reset session-identity state so the next agent_start opens a fresh session span
// (after a /traceroot disable, or a session replacement that reuses this instance).
export function resetForNewSession(state: SpanState): void {
  state.sessionTraceId = null;
  state.sessionFile = null;
  state.sessionStartReason = null;
  state.forkLink = null;
  state.forkedFromSessionFile = null;
  state.promptIndex = 0;
  state.pendingPrompt = null;
  state.lastAssistantText = null;
  state.resumeFrom = null;
  state.pendingInput = null;
  state.compactionSpan = null;
  state.projectFinalized = false;
  // Model + thinking level are session-scoped: a fresh session re-derives them
  // from its own ctx.model / model_select, so a stale cache must not carry over.
  state.currentModel = null;
  state.thinkingLevel = null;
}

// Begin a fresh session on a reused extension instance. pi keeps one module instance
// across sessions, so without this the previous session's spans, turn counter, model,
// last output, and project-finalized flag bleed into the next one. Close anything still
// open first (defensive — session_shutdown normally already did), then clear per-session
// state. providerShutdown is process-scoped and deliberately preserved.
export function beginNewSession(state: SpanState, reason: string): void {
  closeAllOpenSpans(state, reason);
  resetForNewSession(state);
}
