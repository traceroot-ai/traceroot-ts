// Regression + spec tests surfaced by the PR #106 deep review.
//
// Two kinds of tests live here:
//   - GUARDS: assert behavior that is correct today, to lock it against regressions.
//   - todo SPECS: assert the desired post-fix behavior for a CONFIRMED defect. They are
//     marked `{ todo }` so the suite stays green while documenting the gap; flip to a
//     plain test once the underlying issue is fixed. Each cites the finding it pins.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { createSpanState } from "../state.ts";
import { registerLlm } from "./llm.ts";
import { registerTool } from "./tool.ts";
import { registerSession } from "./session.ts";
import type { Runtime } from "../runtime.ts";

interface SpanRecord {
  name: string;
  attrs: Record<string, unknown>;
  events: string[];
  status?: { code: SpanStatusCode; message?: string };
  ended: boolean;
}

// A tracer whose spans record everything set on them, so tests can assert on
// attribute values (the existing llm.test.ts fake span discards them).
function recordingTracer(): { tracer: Tracer; spans: SpanRecord[] } {
  const spans: SpanRecord[] = [];
  const tracer = {
    startSpan(name: string) {
      const rec: SpanRecord = { name, attrs: {}, events: [], ended: false };
      const span = {
        setAttribute(key: string, value: unknown) {
          rec.attrs[key] = value;
          return span;
        },
        setAttributes(obj: Record<string, unknown>) {
          Object.assign(rec.attrs, obj);
          return span;
        },
        addEvent(eventName: string) {
          rec.events.push(eventName);
          return span;
        },
        setStatus(status: { code: SpanStatusCode; message?: string }) {
          rec.status = status;
          return span;
        },
        end() {
          rec.ended = true;
        },
        spanContext: () => ({ traceId: "t".repeat(32), spanId: "s".repeat(16), traceFlags: 1 }),
        isRecording: () => true,
        updateName() {
          return span;
        },
        recordException() {},
      } as unknown as Span;
      spans.push(rec);
      return span;
    },
  } as unknown as Tracer;
  return { tracer, spans };
}

function fakeRuntime(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const { tracer, spans } = recordingTracer();
  const rt = {
    pi: { on: (event: string, handler: (raw: unknown, ctx?: unknown) => unknown) => handlers.set(event, handler) },
    state: createSpanState(),
    config: { captureFullPayload: false, stateDir: "/tmp/pi-review-test", ...config },
    envProvided: {},
    configIssues: [],
    provider: { forceFlush: async () => {}, shutdown: async () => {} },
    tracer,
    debug: () => {},
  } as unknown as Runtime;
  return { rt, handlers, spans };
}

async function fire(
  handlers: Map<string, (raw: unknown, ctx?: unknown) => unknown>,
  name: string,
  raw: unknown,
  ctx?: unknown,
): Promise<void> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`handler ${name} not registered`);
  await handler(raw, ctx);
}

function firstSpan(spans: SpanRecord[]): SpanRecord {
  const span = spans.at(0);
  if (!span) throw new Error("expected at least one recorded span");
  return span;
}

const MODEL_CTX = { model: { provider: "openai", id: "gpt-4o" } };

// ---------------------------------------------------------------------------
// GUARDS — current behavior that must not regress
// ---------------------------------------------------------------------------

test("guard: tool_execution_start ignores a duplicate toolCallId (no double-open)", async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
  await fire(handlers, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
  assert.equal(rt.state.toolSpans.size, 1);
  assert.equal(spans.length, 1, "only one tool span is created for a repeated id");
});

test("guard: tool_execution_end without a matching start is a no-op", async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, "tool_execution_end", { toolCallId: "ghost", isError: false, result: "x" });
  assert.equal(spans.length, 0);
  assert.equal(rt.state.toolSpans.size, 0);
});

test("guard: message_end records token usage on the active LLM span", async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, "turn_start", { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, "message_end", { message: { role: "assistant", usage: { input: 10, output: 5 } } });
  assert.equal(firstSpan(spans).attrs["gen_ai.usage.input_tokens"], 10);
  assert.equal(firstSpan(spans).attrs["gen_ai.usage.output_tokens"], 5);
});

test("guard: tool_execution_end flags an errored tool via tool_is_error and ends the span", async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
  await fire(handlers, "tool_execution_end", { toolCallId: "c1", isError: true, result: "boom" });
  assert.equal(firstSpan(spans).attrs["traceroot.pi.tool_is_error"], true);
  assert.equal(firstSpan(spans).ended, true);
});

// ---------------------------------------------------------------------------
// todo SPECS — confirmed defects; assert the desired post-fix behavior
// ---------------------------------------------------------------------------

test("privacy: request messages are not exported as span input unless captureFullPayload is on", async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: false });
  registerLlm(rt);
  await fire(handlers, "turn_start", { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, "before_provider_request", {
    payload: { messages: [{ role: "system", content: "SECRET SYSTEM PROMPT" }, { role: "user", content: "pii@example.com" }] },
  });
  assert.equal(firstSpan(spans).attrs["traceroot.pi.request_message_count"], 2, "the message count is safe to record");
  assert.equal(firstSpan(spans).attrs["traceroot.span.input"], undefined, "the full conversation must not be exported without opt-in");
});

test("privacy: request messages ARE exported as span input when captureFullPayload is opted in", async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: true });
  registerLlm(rt);
  await fire(handlers, "turn_start", { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, "before_provider_request", { payload: { messages: [{ role: "user", content: "hello-world" }] } });
  assert.ok(String(firstSpan(spans).attrs["traceroot.span.input"] ?? "").includes("hello-world"), "opt-in captures the conversation");
});

test("telemetry: turn_start does not stamp a thinking_level when none was selected", async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, "turn_start", { turnIndex: 0 }, MODEL_CTX);
  assert.equal(firstSpan(spans).attrs["gen_ai.request.thinking_level"], undefined);
});

// pi emits exactly one assistant message per turn (TurnEndEvent carries a single
// `message`); a fresh turn_start opens a new span for the next LLM call. So token usage
// is recorded per call and never shared or overwritten across calls. Verified against
// the installed pi types (core/extensions/types.d.ts: TurnEndEvent). This guards against
// a regression toward a single shared per-loop span.
test("guard: each turn gets its own LLM span with its own usage (no cross-turn bleed)", async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, "turn_start", { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, "message_end", { message: { role: "assistant", usage: { input: 10, output: 5 } } });
  await fire(handlers, "turn_end", { turnIndex: 0 });
  await fire(handlers, "turn_start", { turnIndex: 1 }, MODEL_CTX);
  await fire(handlers, "message_end", { message: { role: "assistant", usage: { input: 20, output: 8 } } });
  const [first, second] = spans;
  assert.ok(first && second, "one LLM span per turn/call");
  assert.equal(spans.length, 2);
  assert.equal(first.attrs["gen_ai.usage.output_tokens"], 5);
  assert.equal(second.attrs["gen_ai.usage.output_tokens"], 8);
});

test(
  "spec: an errored tool should set the OTel span ERROR status, not only a boolean attribute",
  { todo: "P1 TOOL-02 (tool.ts:46-48): call setStatus(ERROR) and extract the error message" },
  async () => {
    const { rt, handlers, spans } = fakeRuntime();
    registerTool(rt);
    await fire(handlers, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
    await fire(handlers, "tool_execution_end", { toolCallId: "c1", isError: true, result: "boom" });
    assert.equal(firstSpan(spans).status?.code, SpanStatusCode.ERROR);
  },
);

test(
  "spec: a new (non-continuation) session_start should reset per-session counters",
  { todo: "P1 SESS-01 (session.ts:26-66): call resetForNewSession so promptIndex/currentModel do not leak across sessions" },
  async () => {
    const { rt, handlers } = fakeRuntime();
    registerSession(rt);
    rt.state.promptIndex = 3;
    rt.state.currentModel = { provider: "openai", id: "gpt-4o" };
    await fire(handlers, "session_start", { reason: "new" }, {});
    assert.equal(rt.state.promptIndex, 0, "turn numbering restarts for a new session");
    assert.equal(rt.state.currentModel, null, "a stale model must not carry into the new session");
  },
);
