// Agent turns. Opens the session span lazily on the first agent_start (so a
// no-prompt session produces zero spans), then a pi.turn span per agent loop.
import { context, SpanKind, TraceFlags, trace, type Context, type Link, type Span } from "@opentelemetry/api";
import { setAttr } from "../attributes.ts";
import { IO_LIMITS, lastAssistantText } from "../content.ts";
import { safeJsonTruncate } from "../json.ts";
import { sweepTurnScoped } from "../state.ts";
import { applyProjectLocal, readProjectLocalConfig } from "../project-config.ts";
import { persistSessionTrace } from "../fork-link.ts";
import { remoteParentContext } from "../remote-parent.ts";
import { hostName, repoSlug, userName, workspaceName } from "../attribution.ts";
import { EXTENSION_VERSION } from "../version.ts";
import { buildTraceUrl } from "../url.ts";
import { setConfigIssue, setStatus, setTraceWidget, STATUS_ACTIVE } from "../ui.ts";
import type { MetadataValue, TracerootPiConfig } from "../config.ts";
import type { Runtime } from "../runtime.ts";
import type { BeforeAgentStartEvent, ExtensionContext, InputEvent } from "../types.ts";
import type { SpanState } from "../state.ts";

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

function applyAdditionalMetadata(span: Span, metadata: Record<string, MetadataValue> | undefined): void {
  if (!metadata) return;
  for (const key of Object.keys(metadata)) {
    setAttr(span, `traceroot.pi.meta.${key}`, metadata[key]);
  }
}

function applyPendingInput(span: Span, state: SpanState, config: TracerootPiConfig): void {
  const input = state.pendingInput;
  if (!input) return;
  setAttr(span, "traceroot.pi.input_source", input.source ?? null);
  setAttr(span, "traceroot.pi.input_streaming_behavior", input.streamingBehavior ?? null);
  setAttr(span, "traceroot.pi.input_image_count", input.imageCount ?? null);
  // Raw input text can contain anything the user typed; gate it like other payloads.
  if (config.captureFullPayload && input.raw) {
    setAttr(span, "traceroot.pi.raw_input", safeJsonTruncate(input.raw, IO_LIMITS.turnInput));
  }
  state.pendingInput = null;
}

function surfaceConfigIssue(rt: Runtime, ctx: ExtensionContext | undefined): void {
  if (rt.configIssues.length === 0) return;
  const primary = rt.configIssues.find((issue) => issue.severity === "error") ?? rt.configIssues[0];
  setConfigIssue(ctx, primary);
}

function openSessionSpan(rt: Runtime, ctx: ExtensionContext | undefined, firstPrompt: string | null): void {
  const { tracer, state, config, debug } = rt;
  // Parent context: a reload/resume continuation first, else an env-provided
  // remote parent (subagent nesting). Either keeps this session in an existing
  // trace; otherwise startSpan with no parent begins a fresh root.
  const parentCtx: Context | undefined =
    state.resumeParent ?? remoteParentContext(config.rootSpanId, config.parentSpanId);
  const sessionSpan = tracer.startSpan(
    "pi.session",
    { kind: SpanKind.INTERNAL, links: sessionLinks(rt) },
    parentCtx,
  );
  const cwd = ctx?.cwd ?? process.cwd();
  setAttr(sessionSpan, "traceroot.pi.start_reason", state.sessionStartReason ?? "startup");
  if (firstPrompt) setAttr(sessionSpan, "traceroot.span.input", firstPrompt);
  setAttr(sessionSpan, "traceroot.pi.cwd", cwd);
  setAttr(sessionSpan, "traceroot.pi.workspace", workspaceName(cwd));
  setAttr(sessionSpan, "traceroot.pi.repo", repoSlug(cwd) ?? null);
  setAttr(sessionSpan, "traceroot.pi.hostname", hostName() ?? null);
  setAttr(sessionSpan, "traceroot.pi.username", userName() ?? null);
  setAttr(sessionSpan, "traceroot.pi.os", process.platform);
  setAttr(sessionSpan, "traceroot.pi.extension_version", EXTENSION_VERSION);
  if (state.forkedFromSessionFile) {
    setAttr(sessionSpan, "traceroot.pi.forked_from_session", state.forkedFromSessionFile);
  }
  if (config.parentSpanId) setAttr(sessionSpan, "traceroot.pi.parent_span_id", config.parentSpanId);
  if (config.rootSpanId) setAttr(sessionSpan, "traceroot.pi.root_span_id", config.rootSpanId);
  applyAdditionalMetadata(sessionSpan, config.additionalMetadata);

  state.sessionSpan = sessionSpan;
  state.sessionCtx = trace.setSpan(context.active(), sessionSpan);
  const sc = sessionSpan.spanContext();
  state.sessionTraceId = sc.traceId;
  try {
    state.sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    state.sessionFile = null;
  }
  // On a reload/resume continuation, keep pointing the persisted file at the
  // original root so repeated reloads stay siblings under it, not a deep chain.
  const persistedRoot = state.resumeFrom ?? { traceId: sc.traceId, spanId: sc.spanId };
  persistSessionTrace(config.stateDir, state.sessionFile, persistedRoot);
  debug("opened session span trace=", sc.traceId, parentCtx ? "(continued)" : "(root)");
}

export function registerTurn(rt: Runtime): void {
  const { pi, state, config } = rt;

  pi.on("before_agent_start", async (raw) => {
    const event = raw as BeforeAgentStartEvent;
    state.pendingPrompt = typeof event?.prompt === "string" ? event.prompt : null;
  });

  // Buffer pi "input" event metadata; applied to the next turn span on agent_start.
  pi.on("input", async (raw) => {
    if (state.sessionDisabled) return;
    const event = raw as InputEvent;
    state.pendingInput = {
      source: typeof event?.source === "string" ? event.source : undefined,
      streamingBehavior: typeof event?.streamingBehavior === "string" ? event.streamingBehavior : undefined,
      imageCount: Array.isArray(event?.images) ? event.images.length : undefined,
      raw: typeof event?.text === "string" ? event.text : undefined,
    };
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
    surfaceConfigIssue(rt, ctx);
    const url = buildTraceUrl(config, state.sessionTraceId);
    setTraceWidget(ctx, config, url, state.sessionTraceId);

    const turnSpan = rt.tracer.startSpan("pi.turn", { kind: SpanKind.INTERNAL }, state.sessionCtx ?? undefined);
    setAttr(turnSpan, "traceroot.pi.turn_index", state.promptIndex);
    // The user prompt is the turn's Input panel.
    if (prompt) setAttr(turnSpan, "traceroot.span.input", prompt);
    applyPendingInput(turnSpan, state, config);
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
