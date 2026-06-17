// Agent turns. Opens the session span lazily on the first agent_start (so a
// no-prompt session produces zero spans), then a pi.turn span per agent loop.
import { context, SpanKind, TraceFlags, trace, type Link } from "@opentelemetry/api";
import { setAttr } from "../attributes.ts";
import { IO_LIMITS, lastAssistantText } from "../content.ts";
import { sweepTurnScoped } from "../state.ts";
import { applyProjectLocal, readProjectLocalConfig } from "../project-config.ts";
import { persistSessionTrace } from "../fork-link.ts";
import { buildTraceUrl } from "../url.ts";
import { setStatus, setTraceWidget, STATUS_ACTIVE } from "../ui.ts";
import type { Runtime } from "../runtime.ts";
import type { BeforeAgentStartEvent, ExtensionContext } from "../types.ts";

function finalizeProjectConfig(rt: Runtime, ctx: ExtensionContext | undefined): void {
  const { state, config, envProvided, debug } = rt;
  if (state.projectFinalized) return;
  state.projectFinalized = true;
  try {
    if (!ctx?.isProjectTrusted?.()) return;
    const raw = readProjectLocalConfig(ctx.cwd ?? process.cwd());
    if (!raw) return;
    const applied = applyProjectLocal(config, raw, envProvided);
    if (applied.length) debug("applied project-local config", applied);
  } catch {
    /* trust check / read failed — keep base config */
  }
}

function sessionLinks(rt: Runtime): Link[] | undefined {
  const { forkLink } = rt.state;
  if (!forkLink) return undefined;
  return [
    {
      context: {
        traceId: forkLink.traceId,
        spanId: forkLink.spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      },
    },
  ];
}

function openSessionSpan(rt: Runtime, ctx: ExtensionContext | undefined, firstPrompt: string | null): void {
  const { tracer, state, config, debug } = rt;
  const sessionSpan = tracer.startSpan("pi.session", {
    kind: SpanKind.INTERNAL,
    links: sessionLinks(rt),
  });
  setAttr(sessionSpan, "traceroot.pi.start_reason", state.sessionStartReason ?? "startup");
  if (firstPrompt) setAttr(sessionSpan, "traceroot.span.input", firstPrompt);
  setAttr(sessionSpan, "traceroot.pi.cwd", ctx?.cwd ?? process.cwd());
  if (state.forkedFromSessionFile) {
    setAttr(sessionSpan, "traceroot.pi.forked_from_session", state.forkedFromSessionFile);
  }
  if (config.parentSpanId) setAttr(sessionSpan, "traceroot.pi.parent_span_id", config.parentSpanId);
  if (config.rootSpanId) setAttr(sessionSpan, "traceroot.pi.root_span_id", config.rootSpanId);

  state.sessionSpan = sessionSpan;
  state.sessionCtx = trace.setSpan(context.active(), sessionSpan);
  const sc = sessionSpan.spanContext();
  state.sessionTraceId = sc.traceId;
  try {
    state.sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    state.sessionFile = null;
  }
  persistSessionTrace(config.stateDir, state.sessionFile, { traceId: sc.traceId, spanId: sc.spanId });
  debug("opened session span trace=", sc.traceId);
}

export function registerTurn(rt: Runtime): void {
  const { pi, state, config } = rt;

  pi.on("before_agent_start", async (raw) => {
    const event = raw as BeforeAgentStartEvent;
    state.pendingPrompt = typeof event?.prompt === "string" ? event.prompt : null;
  });

  pi.on("agent_start", async (_raw, rawCtx) => {
    // Consume the buffered prompt up front so it never sticks to a later loop
    // (e.g. when this loop is skipped because tracing is disabled).
    const prompt = state.pendingPrompt;
    state.pendingPrompt = null;
    if (state.sessionDisabled) return;
    const ctx = rawCtx as ExtensionContext;
    finalizeProjectConfig(rt, ctx);

    if (!state.sessionSpan) openSessionSpan(rt, ctx, prompt);

    // Defensive: a previous agent loop that never emitted agent_end would leave
    // turn-scoped spans open. Close them before starting a new loop.
    if (state.turnSpan) {
      sweepTurnScoped(state);
      try {
        state.turnSpan.end();
      } catch {
        /* best-effort */
      }
      state.turnSpan = null;
      state.turnCtx = null;
    }

    setStatus(ctx, STATUS_ACTIVE);
    const url = buildTraceUrl(config, state.sessionTraceId);
    setTraceWidget(ctx, config, url, state.sessionTraceId);

    const turnSpan = rt.tracer.startSpan("pi.turn", { kind: SpanKind.INTERNAL }, state.sessionCtx ?? undefined);
    setAttr(turnSpan, "traceroot.pi.turn_index", state.promptIndex);
    // The user prompt is the turn's Input panel.
    if (prompt) setAttr(turnSpan, "traceroot.span.input", prompt);
    state.turnSpan = turnSpan;
    state.turnCtx = trace.setSpan(context.active(), turnSpan);
    rt.debug("opened turn span", state.promptIndex);
  });

  pi.on("agent_end", async (raw) => {
    // Close any LLM/tool spans an aborted turn left open, then the turn span.
    sweepTurnScoped(state);
    if (!state.turnSpan) return;
    // The final assistant message is the turn's Output panel.
    const output = lastAssistantText((raw as { messages?: unknown })?.messages, IO_LIMITS.turnOutput);
    if (output) setAttr(state.turnSpan, "traceroot.span.output", output);
    state.turnSpan.end();
    state.turnSpan = null;
    state.turnCtx = null;
    state.promptIndex += 1;
    rt.debug("closed turn span");
  });
}
