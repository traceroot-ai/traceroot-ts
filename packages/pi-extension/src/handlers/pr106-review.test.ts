// Regression + spec tests surfaced by the PR #106 deep review.
//
// Two kinds of tests live here:
//   - GUARDS: assert behavior that is correct today, to lock it against regressions.
//   - todo SPECS: assert the desired post-fix behavior for a CONFIRMED defect. They are
//     marked `{ todo }` so the suite stays green while documenting the gap; flip to a
//     plain test once the underlying issue is fixed. Each cites the finding it pins.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOT_CONTEXT, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { createSpanState } from '../state.ts';
import { registerLlm } from './llm.ts';
import { registerTool } from './tool.ts';
import { registerSession } from './session.ts';
import type { Runtime } from '../runtime.ts';

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
        spanContext: () => ({ traceId: 't'.repeat(32), spanId: 's'.repeat(16), traceFlags: 1 }),
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
  const providerCalls = { flush: 0, shutdown: 0 };
  const rt = {
    pi: {
      on: (event: string, handler: (raw: unknown, ctx?: unknown) => unknown) =>
        handlers.set(event, handler),
    },
    state: createSpanState(),
    config: { captureFullPayload: false, stateDir: '/tmp/pi-review-test', ...config },
    envProvided: {},
    configIssues: [],
    provider: {
      forceFlush: async () => {
        providerCalls.flush += 1;
      },
      shutdown: async () => {
        providerCalls.shutdown += 1;
      },
    },
    tracer,
    debug: () => {},
  } as unknown as Runtime;
  // Default to an open session context: in pi, agent_start always opens the session
  // span (setting sessionCtx) before any turn_start fires. Tests that exercise the
  // no-context edge null this explicitly.
  rt.state.sessionCtx = ROOT_CONTEXT;
  return { rt, handlers, spans, providerCalls };
}

// A context with no-op UI hooks, for handlers that call setStatus/notify.
const UI_CTX = {
  ui: { setStatus() {}, setWidget() {}, notify() {} },
  mode: 'tui',
  hasUI: true,
  cwd: '/tmp',
};

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
  if (!span) throw new Error('expected at least one recorded span');
  return span;
}

const MODEL_CTX = { model: { provider: 'openai', id: 'gpt-4o' } };

// ---------------------------------------------------------------------------
// GUARDS — current behavior that must not regress
// ---------------------------------------------------------------------------

test('guard: tool_execution_start ignores a duplicate toolCallId (no double-open)', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  assert.equal(rt.state.toolSpans.size, 1);
  assert.equal(spans.length, 1, 'only one tool span is created for a repeated id');
});

test('guard: tool_execution_end without a matching start is a no-op', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_end', { toolCallId: 'ghost', isError: false, result: 'x' });
  assert.equal(spans.length, 0);
  assert.equal(rt.state.toolSpans.size, 0);
});

test('guard: message_end records token usage on the active LLM span', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'assistant', usage: { input: 10, output: 5 } },
  });
  assert.equal(firstSpan(spans).attrs['gen_ai.usage.input_tokens'], 10);
  assert.equal(firstSpan(spans).attrs['gen_ai.usage.output_tokens'], 5);
});

test('guard: tool_execution_end flags an errored tool via tool_is_error and ends the span', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', { toolCallId: 'c1', isError: true, result: 'boom' });
  assert.equal(firstSpan(spans).attrs['traceroot.pi.tool_is_error'], true);
  assert.equal(firstSpan(spans).ended, true);
});

// ---------------------------------------------------------------------------
// todo SPECS — confirmed defects; assert the desired post-fix behavior
// ---------------------------------------------------------------------------

test('privacy: request messages are not exported as span input unless captureFullPayload is on', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: false });
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'before_provider_request', {
    payload: {
      messages: [
        { role: 'system', content: 'SECRET SYSTEM PROMPT' },
        { role: 'user', content: 'pii@example.com' },
      ],
    },
  });
  assert.equal(
    firstSpan(spans).attrs['traceroot.pi.request_message_count'],
    2,
    'the message count is safe to record',
  );
  assert.equal(
    firstSpan(spans).attrs['traceroot.span.input'],
    undefined,
    'the full conversation must not be exported without opt-in',
  );
});

test('privacy: request messages ARE exported as span input when captureFullPayload is opted in', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: true });
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'before_provider_request', {
    payload: { messages: [{ role: 'user', content: 'hello-world' }] },
  });
  assert.ok(
    String(firstSpan(spans).attrs['traceroot.span.input'] ?? '').includes('hello-world'),
    'opt-in captures the conversation',
  );
});

test('telemetry: turn_start does not stamp a thinking_level when none was selected', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  assert.equal(firstSpan(spans).attrs['gen_ai.request.thinking_level'], undefined);
});

// pi emits exactly one assistant message per turn (TurnEndEvent carries a single
// `message`); a fresh turn_start opens a new span for the next LLM call. So token usage
// is recorded per call and never shared or overwritten across calls. Verified against
// the installed pi types (core/extensions/types.d.ts: TurnEndEvent). This guards against
// a regression toward a single shared per-loop span.
test('guard: each turn gets its own LLM span with its own usage (no cross-turn bleed)', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'assistant', usage: { input: 10, output: 5 } },
  });
  await fire(handlers, 'turn_end', { turnIndex: 0 });
  await fire(handlers, 'turn_start', { turnIndex: 1 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'assistant', usage: { input: 20, output: 8 } },
  });
  const [first, second] = spans;
  assert.ok(first && second, 'one LLM span per turn/call');
  assert.equal(spans.length, 2);
  assert.equal(first.attrs['gen_ai.usage.output_tokens'], 5);
  assert.equal(second.attrs['gen_ai.usage.output_tokens'], 8);
});

test('lifecycle: a reload session_shutdown flushes but keeps the shared provider alive', async () => {
  const { rt, handlers, providerCalls } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'reload' }, UI_CTX);
  assert.equal(providerCalls.shutdown, 0, 'reload is a session transition, not a terminal quit');
  assert.ok(providerCalls.flush >= 1, 'spans are still flushed across a reload');
  assert.equal(
    rt.state.providerShutdown,
    false,
    'the provider must remain usable for the reloaded session',
  );
});

test('lifecycle: a quit session_shutdown shuts the provider down exactly once', async () => {
  const { rt, handlers, providerCalls } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  assert.equal(providerCalls.shutdown, 1, 'quit is terminal');
  assert.equal(rt.state.providerShutdown, true);
});

test('tool errors set the OTel span ERROR status with an extracted message', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureToolIo: true });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'c1',
    isError: true,
    result: 'command not found',
  });
  assert.equal(firstSpan(spans).status?.code, SpanStatusCode.ERROR);
  assert.equal(firstSpan(spans).status?.message, 'command not found');
});

test('tool error status stays generic (no content leak) when tool-IO capture is off', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureToolIo: false });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'c1',
    isError: true,
    result: 'secret output that must not leak',
  });
  assert.equal(firstSpan(spans).status?.code, SpanStatusCode.ERROR);
  assert.equal(
    firstSpan(spans).status?.message,
    'bash failed',
    'result content must not leak into the status message',
  );
});

test('turn_start does not open an orphan-root LLM span when no session context exists', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  // Simulate the rare disable -> enable-mid-loop window: tracing is on but no
  // agent_start has (re)opened the session span, so there is no parent context.
  rt.state.sessionCtx = null;
  rt.state.turnCtx = null;
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  assert.equal(spans.length, 0, 'no LLM span is opened without a parent context');
  assert.equal(rt.state.llmSpans.size, 0);
});

test('session reset: a new session_start clears per-session state from a reused instance', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.promptIndex = 3;
  rt.state.currentModel = { provider: 'openai', id: 'gpt-4o' };
  rt.state.lastAssistantText = 'leftover from the prior session';
  rt.state.projectFinalized = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.promptIndex, 0, 'turn numbering restarts for a new session');
  assert.equal(rt.state.currentModel, null, 'a stale model must not carry over');
  assert.equal(rt.state.lastAssistantText, null, 'a stale assistant output must not carry over');
  assert.equal(
    rt.state.projectFinalized,
    false,
    'project-local config is re-read for the new session',
  );
});

test('session reset: a new session re-enables tracing (disable is scoped per-session)', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.sessionDisabled = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.sessionDisabled, false, 'a new session starts with tracing enabled');
});

test('session reset: providerShutdown is process-scoped and survives a new session', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.providerShutdown = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(
    rt.state.providerShutdown,
    true,
    'providerShutdown must not be reset across sessions',
  );
});
