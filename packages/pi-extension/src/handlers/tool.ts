// Tool spans, parallel-safe. Keyed by toolCallId (never a single "current tool"),
// parented under the active LLM span. pi runs tools concurrently and their
// start/end events interleave, so position-based tracking would orphan spans.
import { SpanKind } from "@opentelemetry/api";
import { setAttr } from "../attributes.ts";
import { safeJsonTruncate } from "../json.ts";
import { IO_LIMITS, renderToolResult } from "../content.ts";
import { activeParentCtx } from "../state.ts";
import type { Runtime } from "../runtime.ts";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "../types.ts";

export function registerTool(rt: Runtime): void {
  const { pi, state } = rt;

  pi.on("tool_execution_start", async (raw) => {
    if (state.sessionDisabled) return;
    const event = raw as ToolExecutionStartEvent;
    const toolCallId = event?.toolCallId;
    if (!toolCallId) return;
    if (state.toolSpans.has(toolCallId)) return; // never double-open the same call

    const toolName = event?.toolName ?? "unknown";
    const span = rt.tracer.startSpan(`pi.tool.${toolName}`, { kind: SpanKind.INTERNAL }, activeParentCtx(state));
    setAttr(span, "gen_ai.tool.name", toolName);
    setAttr(span, "gen_ai.tool.call.id", toolCallId);
    // gen_ai.tool.call.arguments populates the span's Input panel.
    setAttr(span, "gen_ai.tool.call.arguments", safeJsonTruncate(event?.args, IO_LIMITS.toolArgs));

    state.toolSpans.set(toolCallId, { span, startTime: Date.now(), toolName });
    rt.debug("opened tool span", toolName, toolCallId);
  });

  pi.on("tool_execution_end", async (raw) => {
    const event = raw as ToolExecutionEndEvent;
    const toolCallId = event?.toolCallId;
    if (!toolCallId) return;
    const entry = state.toolSpans.get(toolCallId);
    if (!entry) return; // end without a matching start — ignore rather than orphan

    // gen_ai.tool.call.result populates the span's Output panel.
    setAttr(entry.span, "gen_ai.tool.call.result", renderToolResult(event?.result, IO_LIMITS.toolResult));
    setAttr(entry.span, "traceroot.pi.tool_is_error", event?.isError === true);
    setAttr(entry.span, "traceroot.pi.tool_duration_ms", Date.now() - entry.startTime);

    entry.span.end();
    state.toolSpans.delete(toolCallId);
    rt.debug("closed tool span", entry.toolName, toolCallId);
  });
}
