// Tool spans, parallel-safe. Keyed by toolCallId (never a single "current tool"),
// parented under the active LLM span. pi runs tools concurrently and their
// start/end events interleave, so position-based tracking would orphan spans.
import { SpanKind } from "@opentelemetry/api";
import { setAttr } from "../attributes.ts";
import { safeJsonTruncate } from "../json.ts";
import { IO_LIMITS, renderToolResult } from "../content.ts";
import { formatToolSpanName } from "../span-name.ts";
import { activeParentCtx } from "../state.ts";
import type { Runtime } from "../runtime.ts";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "../types.ts";

export function registerTool(rt: Runtime): void {
  const { pi, state, config } = rt;

  pi.on("tool_execution_start", async (raw) => {
    if (state.sessionDisabled) return;
    const event = raw as ToolExecutionStartEvent;
    const toolCallId = event?.toolCallId;
    if (!toolCallId) return;
    if (state.toolSpans.has(toolCallId)) return; // never double-open the same call

    const toolName = event?.toolName ?? "unknown";
    const span = rt.tracer.startSpan(
      formatToolSpanName(toolName, event?.args),
      { kind: SpanKind.INTERNAL },
      activeParentCtx(state),
    );
    setAttr(span, "gen_ai.tool.name", toolName);
    setAttr(span, "gen_ai.tool.call.id", toolCallId);
    // Tool arguments routinely carry file paths, file contents, and shell commands.
    // Capture the (truncated) Input panel only when tool-IO capture is enabled; the
    // span still records the tool name, id, and (on end) error state and duration.
    if (config.captureToolIo) {
      setAttr(span, "gen_ai.tool.call.arguments", safeJsonTruncate(event?.args, IO_LIMITS.toolArgs));
    }

    state.toolSpans.set(toolCallId, { span, startTime: Date.now(), toolName });
    rt.debug("opened tool span", toolName, toolCallId);
  });

  pi.on("tool_execution_end", async (raw) => {
    const event = raw as ToolExecutionEndEvent;
    const toolCallId = event?.toolCallId;
    if (!toolCallId) return;
    const entry = state.toolSpans.get(toolCallId);
    if (!entry) return; // end without a matching start — ignore rather than orphan

    // Tool results can carry file contents and command output; gate the Output panel
    // behind tool-IO capture. Error state and duration below are always recorded.
    if (config.captureToolIo) {
      setAttr(entry.span, "gen_ai.tool.call.result", renderToolResult(event?.result, IO_LIMITS.toolResult));
    }
    setAttr(entry.span, "traceroot.pi.tool_is_error", event?.isError === true);
    setAttr(entry.span, "traceroot.pi.tool_duration_ms", Date.now() - entry.startTime);

    entry.span.end();
    state.toolSpans.delete(toolCallId);
    rt.debug("closed tool span", entry.toolName, toolCallId);
  });
}
