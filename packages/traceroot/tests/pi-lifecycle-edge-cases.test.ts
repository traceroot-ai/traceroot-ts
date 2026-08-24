// Consolidated pi lifecycle + edge-case coverage: event ordering, span parenting,
// close-event idempotency, the dangling-span sweep, instrumentation edge cases, install
// rollback, tracer reresolution, and the real-SDK shape smoke (merged from
// pi-coding-agent-span-lifecycle.test.ts and pi-coding-agent-lifecycle-edge-cases.test.ts).
// Span-construction/wrapper/wiring coverage lives in pi.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import type { Context, ContextManager, SpanContext } from '@opentelemetry/api';
import { isTracingSuppressed, suppressTracing } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { instrumentPiCodingAgent, stampRootOutput, type AgentMessage } from '../src/pi';
import {
  CapturingExporter,
  assistantMessage,
  attrs,
  makeFakeSessionClass,
  makeRig,
} from './pi-test-helpers';

// Shared by the describes below that need to drive instrumentPiCodingAgent() directly.
function registerCapturingProvider(capture: CapturingExporter): void {
  trace.disable();
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(capture));
  provider.register();
}

describe('pi span lifecycle event ordering', () => {
  // Probes out-of-order/malformed AgentEvent sequences: a span never .end()ed is never exported,
  // so an abandoned span/state must always be force-closed, never silently overwritten.
  it('a second message_start with no intervening message_end/turn_end force-closes the abandoned first LLM span instead of silently dropping it', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt(
      'two message_start events fire back to back, no message_end between them',
    );
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'first-model' }) });
    assert.doesNotThrow(() => {
      session.emit({ type: 'message_start', message: assistantMessage({ model: 'second-model' }) });
    });
    session.emit({ type: 'message_end', message: assistantMessage({ model: 'second-model' }) });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const llmSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'LLM');
    assert.equal(
      llmSpans.length,
      2,
      'both the abandoned first LLM span and the properly-closed second must be exported -- the ' +
        'first must never silently vanish just because state.llmSpan was overwritten',
    );
    const firstSpan = llmSpans.find((s) => attrs(s)['gen_ai.request.model'] === 'first-model');
    const secondSpan = llmSpans.find((s) => attrs(s)['gen_ai.request.model'] === 'second-model');
    assert.ok(
      firstSpan,
      'the abandoned first LLM span must still have been force-closed and exported',
    );
    assert.ok(secondSpan, 'the second LLM span must close normally via message_end');
    assert.equal(
      attrs(firstSpan!)['traceroot.pi.force_closed'],
      true,
      'the abandoned first LLM span must be marked as abnormally closed',
    );
    assert.equal(
      attrs(secondSpan!)['traceroot.pi.force_closed'],
      undefined,
      'the normally-closed second LLM span must NOT be marked force-closed',
    );
  });
});

describe('pi span context parenting', () => {
  // Probes OTel Context/parent-span correctness across turn boundaries and ambient-context leakage.

  // steer() attaches the listener without ever opening a root, unlike prompt() -- the "no root"
  // case the ambient test below needs. Fresh class per rig; the prototype is patched directly.
  function makeSteerRig() {
    trace.disable();
    const capture = new CapturingExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(capture));
    provider.register();
    const Base = makeFakeSessionClass();
    class SteerAgentSession extends Base {
      async steer(_text: string): Promise<void> {}
    }
    instrumentPiCodingAgent({ AgentSession: SteerAgentSession }, {});
    return { capture, Session: SteerAgentSession };
  }

  // A real, synchronous ContextManager, since NoopContextManager makes context.with() a no-op.
  class StackContextManager implements ContextManager {
    private stack: Context[] = [ROOT_CONTEXT];
    active(): Context {
      return this.stack[this.stack.length - 1]!;
    }
    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      ctx: Context,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> {
      this.stack.push(ctx);
      try {
        return fn.call(thisArg, ...args);
      } finally {
        this.stack.pop();
      }
    }
    bind<T>(_ctx: Context, target: T): T {
      return target;
    }
    enable(): this {
      return this;
    }
    disable(): this {
      return this;
    }
  }

  const AMBIENT_SPAN_CONTEXT: SpanContext = {
    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    spanId: 'aaaaaaaaaaaaaaaa',
    traceFlags: TraceFlags.SAMPLED,
  };

  it('a tool span opened during turn 1 keeps its parent bound to turn 1s LLM span (OTel Context is captured immutably at open time) even after turn 2 has already opened its own LLM span before turn 1s tool call closes', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('turn 1s tool call resolves late, after turn 2 already started');
    session.emit({ type: 'agent_start' });

    // llmCtx stays alive after message_end so a tool call in the grace window still parents under it.
    session.emit({ type: 'turn_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'turn-1-model' }) });
    session.emit({ type: 'message_end', message: assistantMessage({ model: 'turn-1-model' }) });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'turn1-tool',
      toolName: 'bash',
      args: { command: 'echo turn1' },
    });
    // turn_end clears state.llmSpan/llmCtx before turn 1's tool call closed (slow-to-arrive completion).
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });

    session.emit({ type: 'turn_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'turn-2-model' }) });

    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'turn1-tool',
      toolName: 'bash',
      result: {},
      isError: false,
    });

    session.emit({ type: 'message_end', message: assistantMessage({ model: 'turn-2-model' }) });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const llmSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'LLM');
    const turn1Llm = llmSpans.find((s) => attrs(s)['gen_ai.request.model'] === 'turn-1-model');
    const turn2Llm = llmSpans.find((s) => attrs(s)['gen_ai.request.model'] === 'turn-2-model');
    assert.ok(turn1Llm);
    assert.ok(turn2Llm);

    const turn1Tool = capture.spans.find((s) => attrs(s)['gen_ai.tool.call.id'] === 'turn1-tool');
    assert.ok(turn1Tool);
    assert.equal(
      turn1Tool!.parentSpanId,
      turn1Llm!.spanContext().spanId,
      "turn 1's tool span must stay bound to turn 1's LLM span -- the parent Context was captured at " +
        'tool_execution_start time and is immutable, so it must not silently move onto turn 2 just ' +
        'because state.llmCtx has since been reassigned',
    );
    assert.notEqual(
      turn1Tool!.parentSpanId,
      turn2Llm!.spanContext().spanId,
      "turn 1's tool span must never parent under turn 2's LLM span",
    );
  });

  it('a stray message_start with no rootCtx never parents under whatever span is ambiently active in the host process', async () => {
    const { capture, Session } = makeSteerRig();
    const session = new Session();

    // steer() attaches the listener without ever opening a root, unlike prompt() -- the "no root" case.
    await session.steer('a stray assistant message with no prompt() ever called');

    const manager = new StackContextManager();
    context.setGlobalContextManager(manager);
    try {
      const ambientCtx = trace.setSpanContext(context.active(), AMBIENT_SPAN_CONTEXT);
      context.with(ambientCtx, () => {
        session.emit({ type: 'message_start', message: assistantMessage() });
        session.emit({ type: 'message_end', message: assistantMessage() });
      });
    } finally {
      context.disable();
    }

    const llmSpan = capture.spans.find((s) => attrs(s)['openinference.span.kind'] === 'LLM');
    assert.ok(llmSpan, 'the stray message still produces an LLM span');
    assert.equal(
      llmSpan!.parentSpanId,
      undefined,
      'with no rootCtx, the LLM span must start a fresh standalone trace (ROOT_CONTEXT), not ' +
        'silently attach to whatever span the host process happens to have ambiently active',
    );
    assert.notEqual(
      llmSpan!.spanContext().traceId,
      AMBIENT_SPAN_CONTEXT.traceId,
      'the stray LLM span must not join the ambient hosts trace',
    );
  });

  it('a stray message_start with no rootCtx is still suppressed inside a local eval run', async () => {
    // Same "no root established" starting point as the test above (steer() before any prompt()),
    // but this time the ambient context is a local run's suppressTracing(), not a host span. The
    // fallback at pi.ts's message_start/tool_execution_start branches used to be a bare
    // ROOT_CONTEXT, which drops every ambient context value including that suppression flag --
    // the same bug shape already fixed via forcedTraceRootContext() in spans.ts/observe.ts, found
    // here too by a later audit and fixed the same way.
    const { capture, Session } = makeSteerRig();
    const session = new Session();
    await session.steer(
      'a stray assistant message with no prompt() ever called, inside a local run',
    );

    await context.with(suppressTracing(context.active()), async () => {
      assert.ok(isTracingSuppressed(context.active()), 'sanity: suppression really is active here');
      session.emit({ type: 'message_start', message: assistantMessage() });
      session.emit({ type: 'message_end', message: assistantMessage() });
    });

    const llmSpan = capture.spans.find((s) => attrs(s)['openinference.span.kind'] === 'LLM');
    assert.equal(
      llmSpan,
      undefined,
      'a stray message_start with no rootCtx must stay suppressed inside a local run, not fall ' +
        'back to a bare ROOT_CONTEXT that silently drops the suppression flag',
    );
  });
});

describe('pi close-event idempotency and content safety', () => {
  // Duplicate/late CLOSE events and malformed message content that could throw before
  // endSpanSafe() ran, silently dropping the span.
  it('tool_execution_end firing twice for the same toolCallId exports exactly one tool span and never crashes on the second (stale) close', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('a buggy tool runner emits two end events for one call id');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage() });
    session.emit({ type: 'message_end', message: assistantMessage() });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'echo hi' },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { ok: true },
      isError: false,
    });
    assert.doesNotThrow(() => {
      session.emit({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'bash',
        result: { ok: true },
        isError: false,
      });
    });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const toolSpans = capture.spans.filter((s) => attrs(s)['gen_ai.tool.call.id'] === 't1');
    assert.equal(toolSpans.length, 1, 'exactly one tool span despite two end events');
    assert.equal(
      attrs(toolSpans[0]!)['traceroot.pi.force_closed'],
      undefined,
      'the tool span closed normally via the first end -- it must not be marked force_closed',
    );
  });

  // agent_end never closes the root itself, only stamps output -- a duplicate is a harmless repeated stamp.
  it('agent_end firing twice for one attempt before prompt() settles stamps output idempotently', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('a duplicate agent_end fires for one run');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    assert.doesNotThrow(() => {
      session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    });
    await done;

    const rootSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'AGENT');
    assert.equal(rootSpans.length, 1, 'the root span must be closed and exported exactly once');
    assert.equal(
      attrs(rootSpans[0]!)['traceroot.pi.force_closed'],
      undefined,
      'the root span closed normally when prompt() settled',
    );
  });

  it('message_end with a malformed assistant message (content is not an array) still ends and exports the LLM span instead of leaking it unended', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('message_end delivers a malformed assistant message');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'the-model' }) });
    // assistantTextOf() throws inside closeLlmSpan, wrapped in try/catch so endSpanSafe() still runs.
    assert.doesNotThrow(() => {
      session.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          // @ts-expect-error intentionally malformed content to probe robustness
          content: undefined,
          model: 'the-model',
          stopReason: 'stop',
          timestamp: 0,
        },
      });
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const llmSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'LLM');
    assert.equal(llmSpans.length, 1, 'the LLM span must still be exported');
    assert.equal(
      attrs(llmSpans[0]!)['traceroot.pi.force_closed'],
      undefined,
      "message_end is the LLM span's normal close -- a malformed content payload must not " +
        'demote it to a force-closed span (which means span.end() was skipped in closeLlmSpan)',
    );
  });
});

describe('pi dangling-span sweep deduplication', () => {
  // Guards that the dangling-span sweep runs at every call site (agent_start, turn_end, agent_end,
  // proto.prompt's overlap check, dispose() -- the last covered in pi.test.ts) via real scenarios.
  it('agent_start sweeps a dangling LLM + TOOL span from a crashed prior ATTEMPT, but leaves the still-open root untouched', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('attempt one crashes mid-flight, the loop restarts it');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'attempt1-llm' }) });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'attempt1-tool',
      toolName: 'read_file',
      args: { path: '/tmp/one' },
    });
    assert.equal(capture.spans.length, 0, 'nothing exports while the root is still open');

    session.emit({ type: 'agent_start' });

    assert.equal(
      capture.spans.length,
      2,
      "agent_start must force-close attempt one's LLM and TOOL spans only, not the still-open root " +
        `(found ${capture.spans.length})`,
    );
    const llmSpan = capture.spans.find((s) => attrs(s)['gen_ai.request.model'] === 'attempt1-llm');
    const toolSpan = capture.spans.find((s) => attrs(s)['gen_ai.tool.call.id'] === 'attempt1-tool');
    assert.ok(llmSpan && toolSpan, "attempt one's LLM and TOOL spans must be exported");
    for (const span of [llmSpan!, toolSpan!]) {
      assert.equal(
        attrs(span)['traceroot.pi.force_closed'],
        true,
        `${span.name} must be marked force_closed by agent_start's sweep`,
      );
    }
    assert.equal(
      capture.spans.find((s) => s.name === 'AgentSession.prompt'),
      undefined,
      'the root span must still be open -- agent_start never force-closes it under the new model',
    );

    session.emit({
      type: 'agent_end',
      messages: [assistantMessage({ content: [{ type: 'text', text: 'recovered' }] })],
      willRetry: false,
    });
    await done;

    const rootSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'AGENT');
    assert.equal(rootSpans.length, 1, 'exactly one root span for the whole prompt() call');
    assert.equal(attrs(rootSpans[0]!)['output.value'], 'recovered');
  });

  it('turn_end force-closes a dangling LLM + TOOL span but leaves the root span open', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('run with a stream error mid-turn');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'turn-llm' }) });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'turn-tool',
      toolName: 'read_file',
      args: { path: '/tmp/turn' },
    });

    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });

    assert.equal(
      capture.spans.length,
      2,
      'turn_end must force-close exactly the dangling LLM + TOOL spans, not the root span (found ' +
        `${capture.spans.length})`,
    );
    const llmSpan = capture.spans.find((s) => attrs(s)['gen_ai.request.model'] === 'turn-llm');
    const toolSpan = capture.spans.find((s) => attrs(s)['gen_ai.tool.call.id'] === 'turn-tool');
    assert.ok(llmSpan && toolSpan, 'the LLM and TOOL spans must be force-closed and exported');
    assert.equal(attrs(llmSpan!)['traceroot.pi.force_closed'], true);
    assert.equal(attrs(toolSpan!)['traceroot.pi.force_closed'], true);
    assert.equal(
      capture.spans.find((s) => s.name === 'AgentSession.prompt'),
      undefined,
      'the root span must still be open (turn_end is not session end), so it must not export yet',
    );

    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;
  });

  it('agent_end sweeps a dangling LLM + TOOL span while stamping (not force-closing, not even ending) the still-open root', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('run that ends with tool/LLM spans still dangling');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'end-llm' }) });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'end-tool',
      toolName: 'read_file',
      args: { path: '/tmp/end' },
    });

    // The LLM + TOOL spans never see their own close: agent_end's sweep force-closes both, then stamps
    // output onto the root without ending it.
    session.emit({
      type: 'agent_end',
      messages: [assistantMessage({ content: [{ type: 'text', text: 'stamped output' }] })],
      willRetry: false,
    });

    assert.equal(capture.spans.length, 2, 'only the LLM and TOOL spans export so far');
    const llmSpan = capture.spans.find((s) => attrs(s)['gen_ai.request.model'] === 'end-llm');
    const toolSpan = capture.spans.find((s) => attrs(s)['gen_ai.tool.call.id'] === 'end-tool');
    assert.ok(llmSpan && toolSpan);
    assert.equal(
      attrs(llmSpan!)['traceroot.pi.force_closed'],
      true,
      "the dangling LLM span must be force-closed by agent_end's sweep",
    );
    assert.equal(
      attrs(toolSpan!)['traceroot.pi.force_closed'],
      true,
      "the dangling TOOL span must be force-closed by agent_end's sweep",
    );
    assert.equal(
      capture.spans.find((s) => s.name === 'AgentSession.prompt'),
      undefined,
      'the root span must still be open -- agent_end only stamps it, never ends it',
    );

    await done;

    const rootSpan = capture.spans.find((s) => s.name === 'AgentSession.prompt');
    assert.ok(rootSpan, 'the root span exports once prompt() settles');
    assert.equal(attrs(rootSpan!)['output.value'], 'stamped output');
    assert.notEqual(
      attrs(rootSpan!)['traceroot.pi.force_closed'],
      true,
      'the root span must be closed normally when prompt() settles, not force-closed',
    );
  });

  // A second prompt() call while a previous window's root is still open (rare; isStreaming guards most
  // overlaps, but not verified to cover every path) must force-close the stale window, not leak it.
  it("a second prompt() call while the first window's root is still open force-closes the first root (and its dangling LLM/TOOL), then opens a fresh root for the second", async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done1 = session.prompt('first window never got its agent_end');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'overlap-llm' }) });
    assert.equal(capture.spans.length, 0, 'nothing exports while the first root is still open');

    const done2 = session.prompt('second window');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done2;
    // done1 never settles on its own; only the sweep's effect on spans matters here.
    void done1;

    const rootSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'AGENT');
    assert.equal(rootSpans.length, 2, 'both the swept first root and the second root export');
    const firstRoot = rootSpans.find(
      (s) => attrs(s)['input.value'] === 'first window never got its agent_end',
    );
    const secondRoot = rootSpans.find((s) => attrs(s)['input.value'] === 'second window');
    assert.ok(firstRoot, 'the first (overlapped) root must still export');
    assert.ok(secondRoot, 'the second root must export normally');
    assert.equal(
      attrs(firstRoot!)['traceroot.pi.force_closed'],
      true,
      'the first root must be marked force_closed by the overlap sweep',
    );
    assert.equal(
      attrs(firstRoot!)['traceroot.pi.force_closed_reason'],
      'superseded_by_new_prompt',
      'the superseded root records WHY it was force-closed, so a truncated trace is debuggable',
    );
    assert.notEqual(
      attrs(secondRoot!)['traceroot.pi.force_closed'],
      true,
      'the second root must close normally via its own prompt() settle',
    );
    const overlapLlm = capture.spans.find(
      (s) => attrs(s)['gen_ai.request.model'] === 'overlap-llm',
    );
    assert.ok(overlapLlm, "the first window's dangling LLM span must also be swept, not leaked");
    assert.equal(attrs(overlapLlm!)['traceroot.pi.force_closed'], true);
    assert.notEqual(
      firstRoot!.spanContext().traceId,
      secondRoot!.spanContext().traceId,
      'the two overlapping windows must live in genuinely separate traces',
    );
  });

  // A mid-stream steer/followUp must not be treated as an overlap: before this fix, proto.prompt couldn't
  // distinguish it from a genuine overlapping call and force-closed the still-live active root/LLM span.
  it("a mid-stream steer (isStreaming===true, streamingBehavior set) never opens a fresh root or sweeps the active run's still-open root -- the active trace stays intact", async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('first task, still running');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage({ model: 'active-llm' }) });

    // A mid-stream steer call in this state must delegate straight through -- no new root, no overlap sweep.
    session.isStreaming = true;
    await session.prompt('steer text', { streamingBehavior: 'steer' });

    assert.equal(
      capture.spans.length,
      0,
      "the mid-stream steer call must not force-close or export anything -- the active run's root " +
        'and LLM span are still genuinely open',
    );

    session.isStreaming = false;
    session.emit({
      type: 'message_end',
      message: assistantMessage({
        model: 'active-llm',
        content: [{ type: 'text', text: 'steered result' }],
      }),
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({
      type: 'agent_end',
      messages: [assistantMessage({ content: [{ type: 'text', text: 'steered result' }] })],
      willRetry: false,
    });
    await done;

    const rootSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'AGENT');
    assert.equal(
      rootSpans.length,
      1,
      'exactly one intact root for the whole run -- the steer call never opened a second one',
    );
    const root = rootSpans[0]!;
    assert.notEqual(
      attrs(root)['traceroot.pi.force_closed'],
      true,
      'the active root must NOT be force-closed by the mid-stream steer',
    );
    assert.equal(attrs(root)['output.value'], 'steered result');

    const llmSpan = capture.spans.find((s) => attrs(s)['openinference.span.kind'] === 'LLM');
    assert.ok(llmSpan, "the active run's LLM span must still export normally");
    assert.notEqual(
      attrs(llmSpan!)['traceroot.pi.force_closed'],
      true,
      'the active LLM span must not have been swept by the steer call',
    );
    assert.equal(
      llmSpan!.parentSpanId,
      root.spanContext().spanId,
      'the LLM span must remain a child of the single intact root',
    );
  });

  // Before this fix, finalize only ended the root span -- a mid-run rejection left a still-open
  // tool/LLM span never .end()ed, silently dropped rather than exported.
  it('a prompt() call that REJECTS mid-run force-closes a still-open tool span before finalizing the root as ERROR (claude-agent-sdk.ts endInFlight parity)', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt(
      'a run whose internal loop rejects while a tool call is still open',
    );
    session.emit({ type: 'agent_start' });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'reject-tool',
      toolName: 'bash',
      args: { command: 'sleep 999' },
    });
    assert.equal(capture.spans.length, 0, 'nothing exports while the run is still open');

    session.rejectPrompt(new Error('internal agent loop failure'));
    await assert.rejects(() => done, /internal agent loop failure/);

    assert.equal(
      capture.spans.length,
      2,
      'the still-open tool span AND the root must both export once the rejection settles ' +
        `(found ${capture.spans.length})`,
    );
    const rootSpan = capture.spans.find((s) => s.name === 'AgentSession.prompt');
    const toolSpan = capture.spans.find((s) => attrs(s)['gen_ai.tool.call.id'] === 'reject-tool');
    assert.ok(rootSpan);
    assert.ok(toolSpan, 'the dangling tool span must still export, not be dropped forever');
    assert.equal(
      attrs(toolSpan!)['traceroot.pi.force_closed'],
      true,
      "the tool span must be force-closed by finalize's pre-close sweep",
    );
    assert.equal(
      toolSpan!.parentSpanId,
      rootSpan!.spanContext().spanId,
      'the force-closed tool span must still be parented under the root',
    );

    assert.equal(rootSpan!.status.code, 2 /* SpanStatusCode.ERROR */);
    assert.equal(
      rootSpan!.events.some((e) => e.name === 'exception'),
      true,
      'the rejection reason must be recorded as an exception on the root span',
    );
  });
});

describe('pi instrumentation edge cases', () => {
  it('instrumenting the same sdk object twice does not double-wrap prompt', async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };

    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const wrappedOnce = Session.prototype.prompt;
    instrumentPiCodingAgent(sdk, {});
    const wrappedTwice = Session.prototype.prompt;

    assert.equal(
      wrappedOnce,
      wrappedTwice,
      'a second instrumentPiCodingAgent() call must be a no-op',
    );

    const session = new Session();
    const done = session.prompt('hi');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    assert.equal(
      capture.spans.length,
      1,
      'exactly one root span, not two -- proves subscribe() was not registered twice',
    );
  });

  // A real `import * as pi` namespace object is always non-extensible per spec; Object.preventExtensions
  // reproduces that shape -- the wrap-once guard must never be stamped directly onto `sdk` itself.
  it('instrumenting a non-extensible sdk object (e.g. a real `import * as pi` ES module namespace) does not throw', async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = Object.preventExtensions({ AgentSession: Session });

    registerCapturingProvider(capture);
    assert.doesNotThrow(() => {
      instrumentPiCodingAgent(sdk, {});
    });

    const session = new Session();
    const done = session.prompt('hi');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    assert.equal(
      capture.spans.length,
      1,
      'instrumentation still works end-to-end against a non-extensible sdk object',
    );

    const wrappedOnce = Session.prototype.prompt;
    assert.doesNotThrow(() => {
      instrumentPiCodingAgent(sdk, {});
    });
    assert.equal(Session.prototype.prompt, wrappedOnce);
  });

  // Guards silent double-instrumentation across independently-loaded copies sharing one prototype: a
  // module-scoped `Symbol()` guard would fail silently, so this must use the interned Symbol.for(key).
  it('the wrap-once guard key is the globally-interned Symbol.for() value, and a second call is an idempotent no-op', () => {
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };

    instrumentPiCodingAgent(sdk, {});

    const guardKeys = Object.getOwnPropertySymbols(Session.prototype).filter(
      (sym) => sym.description === 'traceroot.pi.wrapped',
    );
    assert.equal(guardKeys.length, 1, 'exactly one wrap-once guard key should be stamped');
    assert.equal(
      guardKeys[0],
      Symbol.for('traceroot.pi.wrapped'),
      'the guard key must be the globally-interned Symbol.for() value -- not a ' +
        'module-scoped Symbol() -- so that two independently-loaded copies of ' +
        "this module sharing one AgentSession.prototype detect each other's " +
        'stamp instead of silently double-wrapping and doubling every span export',
    );

    // A second call for an already-instrumented sdk is silently idempotent (mirrors
    // claude-agent-sdk's wrap-once return); the first call's config stands.
    const wrappedOnce = Session.prototype.prompt;
    instrumentPiCodingAgent(sdk, { captureContent: false });
    assert.equal(
      Session.prototype.prompt,
      wrappedOnce,
      "a second instrumentPiCodingAgent() call with a different config must not re-wrap; it's an idempotent no-op",
    );
  });

  it('two different session instances on the same instrumented sdk keep fully independent span trees', async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});

    const sessionA = new Session();
    const sessionB = new Session();
    (sessionA as { sessionId: string }).sessionId = 'session-a';
    (sessionB as { sessionId: string }).sessionId = 'session-b';

    // Interleaved on purpose: A starts, B starts, A's tool call runs, B's turn ends, A ends.
    const doneA = sessionA.prompt('task A');
    sessionA.emit({ type: 'agent_start' });
    const doneB = sessionB.prompt('task B');
    sessionB.emit({ type: 'agent_start' });
    sessionA.emit({ type: 'message_start', message: assistantMessage() });
    sessionA.emit({ type: 'message_end', message: assistantMessage() });
    sessionA.emit({
      type: 'tool_execution_start',
      toolCallId: 'a-tool',
      toolName: 'bash',
      args: {},
    });
    sessionA.emit({
      type: 'tool_execution_end',
      toolCallId: 'a-tool',
      toolName: 'bash',
      result: {},
      isError: false,
    });
    sessionB.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    sessionA.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await Promise.all([doneA, doneB]);

    assert.equal(capture.spans.length, 4, 'A: root+LLM+tool (3), B: root (1)');

    const bRoot = capture.spans.find((s) => attrs(s)['session.id'] === 'session-b');
    const aRoot = capture.spans.find((s) => attrs(s)['session.id'] === 'session-a');
    assert.ok(bRoot);
    assert.ok(aRoot);
    // Only root spans carry session.id and only tool spans carry tool.call.id, so "everything that
    // isn't B's root" correctly counts A's 3 spans (the LLM span carries neither).
    const aRelated = capture.spans.filter((s) => s !== bRoot);
    assert.equal(aRelated.length, 3, 'A: root + LLM + tool span');
    assert.notEqual(bRoot!.spanContext().traceId, aRoot!.spanContext().traceId);
  });

  it('message_start/message_end for non-assistant roles never opens an LLM span', async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    const done = session.prompt('hi');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: { role: 'user', content: 'hi', timestamp: 0 } });
    session.emit({ type: 'message_end', message: { role: 'user', content: 'hi', timestamp: 0 } });
    session.emit({
      type: 'message_start',
      message: {
        role: 'toolResult',
        toolCallId: 'x',
        toolName: 'bash',
        content: [],
        isError: false,
        timestamp: 0,
      },
    });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    assert.equal(
      capture.spans.length,
      1,
      'only the root span -- no LLM span for user/toolResult messages',
    );
  });

  it('a handler throw inside span-building is caught and never propagates to session.emit()', async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    const done = session.prompt('hi');
    session.emit({ type: 'agent_start' });
    // A malformed/missing `usage` field must not crash the listener -- attribute setters must tolerate it.
    assert.doesNotThrow(() => {
      session.emit({
        type: 'message_end',
        // @ts-expect-error intentionally malformed to test resilience
        message: { role: 'assistant', content: [], stopReason: 'stop', timestamp: 0 },
      });
    });
    assert.doesNotThrow(() => {
      session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    });
    await done;
  });

  // This fake's prompt() is plain (non-async) and throws before returning a promise, exercising the
  // synchronous catch branch: the wrapper must finalize the root as ERROR and rethrow synchronously.
  it('a prompt() that throws SYNCHRONOUSLY (before ever returning a promise) still finalizes the root as ERROR and rethrows synchronously, not as a rejected promise', () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    Session.prototype.prompt = function (): never {
      throw new Error('synchronous validation failure');
    };
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    assert.throws(() => session.prompt('hi'), /synchronous validation failure/);

    assert.equal(capture.spans.length, 1);
    const rootSpan = capture.spans[0]!;
    assert.equal(attrs(rootSpan)['openinference.span.kind'], 'AGENT');
    assert.equal(rootSpan.status.code, 2 /* SpanStatusCode.ERROR */);
    assert.equal(
      rootSpan.events.some((e) => e.name === 'exception'),
      true,
      'the synchronously-thrown error must still be recorded as an exception on the root span',
    );
  });

  it("a prompt() call whose run retries once (willRetry: true) keeps ONE root span open across the retry continuation, closing it exactly once with retry_count stamped, and both attempts' LLM spans (ERROR then OK) parent under that single root", async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    // The retry continuation's agent_start/agent_end fire with no new prompt() call, so both attempts
    // (and each one's own child LLM span) must land under the same still-open root.
    const done = session.prompt('hi');
    session.emit({ type: 'agent_start' });
    session.emit({
      type: 'message_start',
      message: assistantMessage({ model: 'attempt-1-model' }),
    });
    session.emit({
      type: 'message_end',
      message: assistantMessage({
        model: 'attempt-1-model',
        stopReason: 'error',
        errorMessage: 'rate limited',
      }),
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: true });
    // Retry re-enters the loop; no new prompt() call.
    session.emit({ type: 'agent_start' });
    session.emit({
      type: 'message_start',
      message: assistantMessage({ model: 'attempt-2-model' }),
    });
    session.emit({ type: 'message_end', message: assistantMessage({ model: 'attempt-2-model' }) });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const rootSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'AGENT');
    assert.equal(
      rootSpans.length,
      1,
      'the retry continuation shares ONE root span with its first attempt, not two',
    );
    const root = rootSpans[0]!;
    assert.equal(attrs(root)['traceroot.pi.retry_count'], 1);
    assert.equal(attrs(root)['traceroot.pi.will_retry'], undefined, 'the flag is gone');

    const llmSpans = capture.spans.filter((s) => attrs(s)['openinference.span.kind'] === 'LLM');
    assert.equal(llmSpans.length, 2, 'each attempt gets its own child LLM span, not a merged one');
    const errorLlm = llmSpans.find((s) => attrs(s)['gen_ai.request.model'] === 'attempt-1-model');
    const okLlm = llmSpans.find((s) => attrs(s)['gen_ai.request.model'] === 'attempt-2-model');
    assert.ok(errorLlm, "attempt 1's LLM span must be present");
    assert.ok(okLlm, "attempt 2's LLM span must be present");
    assert.equal(
      errorLlm!.status.code,
      SpanStatusCode.ERROR,
      "attempt 1's LLM span must carry the ERROR status from its failing stopReason",
    );
    assert.equal(
      okLlm!.status.code,
      SpanStatusCode.UNSET,
      "attempt 2's LLM span must NOT be ERROR -- it is the successful retry",
    );
    assert.equal(
      errorLlm!.parentSpanId,
      root.spanContext().spanId,
      "attempt 1's (failed) LLM span must parent under the single shared root, not a discarded one",
    );
    assert.equal(
      okLlm!.parentSpanId,
      root.spanContext().spanId,
      "attempt 2's (succeeded) LLM span must parent under the SAME single shared root as attempt 1",
    );
  });
});

describe('pi install rollback', () => {
  // A failure mid-install must leave AgentSession.prototype exactly as found: no half-patched
  // methods and no wrap-once guard stamped (which would reject every retry).

  const WRAPPED = Symbol.for('traceroot.pi.wrapped');

  it('a setup failure after the wrap-once decision does not leave the guard stamped or the prototype half-patched', () => {
    const provider = new NodeTracerProvider();
    provider.register();
    try {
      // `steer` throws the first time setup probes it, standing in for any exception mid-install.
      class ThrowingSteerSession {
        sessionId = 's';
        prompt(): void {}
        subscribe(): () => void {
          return () => {};
        }
        get steer(): unknown {
          throw new Error('injected setup failure while probing steer');
        }
      }
      const proto = ThrowingSteerSession.prototype as unknown as Record<PropertyKey, unknown>;
      const originalPrompt = proto.prompt;
      const sdk = { AgentSession: ThrowingSteerSession };

      // A mid-setup failure must surface as a clear, rethrown install error, not be swallowed.
      assert.throws(
        () => instrumentPiCodingAgent(sdk, {}),
        /failed to install/i,
        'a mid-setup failure must surface as a clear instrumentation-install error',
      );

      // The guard must NOT be stamped after a failed install: leaving it true would reject every retry.
      assert.equal(
        proto[WRAPPED],
        undefined,
        'the wrap-once guard must not be stamped when install failed partway through',
      );

      // prompt must be the ORIGINAL method, not a half-installed wrapper, or a retry double-instruments.
      assert.equal(
        proto.prompt,
        originalPrompt,
        'a failed install must roll the prompt patch back, leaving the prototype unpatched',
      );
    } finally {
      trace.disable();
    }
  });
});

describe('pi close-root-span backward scan', () => {
  // stampRootOutput's search for the last assistant message must keep walking past trailing
  // non-assistant messages; it only stamps output.value, so the test ends the span explicitly.
  it('stampRootOutput still finds the last assistant message when later messages are not assistant messages', () => {
    const capture = new CapturingExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(capture));
    const tracer = provider.getTracer('close-root-span-backward-scan-test');
    const span = tracer.startSpan('AgentSession.prompt');

    const finalMessages: AgentMessage[] = [
      { role: 'user', content: 'question', timestamp: 0 },
      assistantMessage({ content: [{ type: 'text', text: 'an earlier, superseded answer' }] }),
      { role: 'user', content: 'follow-up', timestamp: 0 },
      assistantMessage({ content: [{ type: 'text', text: 'the real answer' }] }),
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        content: [],
        isError: false,
        timestamp: 0,
      },
    ];

    stampRootOutput(span, finalMessages, true);
    span.end();

    const exported = capture.spans[0];
    assert.ok(exported, 'expected the root span to have been exported');
    assert.equal(attrs(exported)['output.value'], 'the real answer');
  });
});

describe('pi tracer reresolution', () => {
  // TraceRoot.shutdown() swaps the OTel API's ProxyTracerProvider for a new instance rather than
  // mutating it, so a tracer captured once at wrap time would go dark; pi re-resolves the tracer
  // through the global `trace` facade on every span-open instead.

  function registerProvider(): { provider: NodeTracerProvider; exporter: InMemorySpanExporter } {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
    return { provider, exporter };
  }

  // The three process-wide resets TraceRoot.shutdown() performs.
  async function runShutdownSequence(provider: NodeTracerProvider): Promise<void> {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  }

  it('an already-instrumented AgentSession keeps exporting across a shutdown()/initialize() cycle', async () => {
    const a = registerProvider();
    let b: { provider: NodeTracerProvider; exporter: InMemorySpanExporter } | undefined;
    try {
      const Session = makeFakeSessionClass();
      const sdk = { AgentSession: Session };
      instrumentPiCodingAgent(sdk, {}); // wraps the prototype once, tracer re-resolved per span

      const s1 = new Session();
      const done1 = s1.prompt('first run');
      s1.emit({ type: 'agent_start' });
      s1.emit({
        type: 'agent_end',
        messages: [assistantMessage({ content: [{ type: 'text', text: 'done A' }] })],
        willRetry: false,
      });
      await done1;
      assert.ok(
        a.exporter.getFinishedSpans().some((s) => attrs(s)['openinference.span.kind'] === 'AGENT'),
        'sanity: the first run must export through provider A',
      );

      // The prototype stays wrapped, so recovery depends entirely on the tracer re-resolving.
      await runShutdownSequence(a.provider);
      b = registerProvider();

      const s2 = new Session();
      const done2 = s2.prompt('second run');
      s2.emit({ type: 'agent_start' });
      s2.emit({
        type: 'agent_end',
        messages: [assistantMessage({ content: [{ type: 'text', text: 'done B' }] })],
        willRetry: false,
      });
      await done2;

      const rootB = b.exporter
        .getFinishedSpans()
        .find((s) => attrs(s)['openinference.span.kind'] === 'AGENT');
      assert.ok(
        rootB,
        'the second run must export through provider B after the cycle -- no silent black hole',
      );
      assert.equal(attrs(rootB!)['input.value'], 'second run');
    } finally {
      trace.disable();
    }
  });
});

describe('pi real SDK shape smoke', () => {
  // src/pi.ts hand-cites private internals of the real SDK, none part of a stable public contract;
  // these verify those shapes against the actual devDependency so a version bump fails loudly here.

  // ESM-only, so loaded via dynamic import() rather than a static import this CommonJS file can't use.
  type RealSdk = {
    AgentSession?: { prototype: Record<string, unknown> };
  };
  let cachedSdk: Promise<RealSdk> | undefined;
  function loadRealSdk(): Promise<RealSdk> {
    if (!cachedSdk) {
      cachedSdk = import('@earendil-works/pi-coding-agent') as unknown as Promise<RealSdk>;
    }
    return cachedSdk;
  }

  it('the real AgentSession still exposes every prototype method instrumentPiCodingAgent patches or reads', async () => {
    const sdk = await loadRealSdk();
    const AgentSession = sdk.AgentSession;
    assert.equal(typeof AgentSession, 'function', 'AgentSession must still be an exported class');
    const proto = AgentSession!.prototype;

    // Required by the install guard, which disables itself if either is missing.
    assert.equal(
      typeof proto.prompt,
      'function',
      'AgentSession.prototype.prompt must exist -- the whole patch layer keys off it',
    );
    assert.equal(
      typeof proto.subscribe,
      'function',
      'AgentSession.prototype.subscribe must exist -- the entire span tree is built from one subscribe() listener',
    );

    // Optional-guarded in the patch layer, but expected present on the real SDK.
    assert.equal(
      typeof proto.steer,
      'function',
      'AgentSession.prototype.steer must exist -- patched as a standalone first-interaction entry point',
    );
    assert.equal(
      typeof proto.followUp,
      'function',
      'AgentSession.prototype.followUp must exist -- patched as a standalone first-interaction entry point',
    );
    assert.equal(
      typeof proto.dispose,
      'function',
      'AgentSession.prototype.dispose must exist -- patched to force-close in-flight spans on teardown',
    );

    // isStreaming is a getter read live on every prompt() call; a renamed/dropped getter would silently
    // reintroduce the mid-stream-steer trace-beheading bug this check exists to prevent.
    assert.equal(
      typeof Object.getOwnPropertyDescriptor(proto, 'isStreaming')?.get,
      'function',
      'AgentSession.prototype.isStreaming must still be a getter -- proto.prompt reads it to detect a mid-stream queue-only steer/followUp call',
    );
  });

  it('the real AgentSession.subscribe() still pushes onto a private _eventListeners array its unsubscribe closure splices back out', async () => {
    const sdk = await loadRealSdk();
    // The "no cleanup needed" design rests on subscribe() pushing onto a private field literally named
    // _eventListeners, which dispose() reassigns to []; a rename leaves this seeded array untouched.
    const proto = sdk.AgentSession!.prototype as unknown as { subscribe(l: unknown): () => void };
    const instance = Object.create(proto) as {
      _eventListeners: unknown[];
      subscribe(l: unknown): () => void;
    };
    instance._eventListeners = [];
    const listener = (): void => {};

    const unsubscribe = instance.subscribe(listener);
    assert.equal(typeof unsubscribe, 'function', 'subscribe() must return an unsubscribe closure');
    assert.ok(
      instance._eventListeners.includes(listener),
      "subscribe() must push the listener onto a private array field named _eventListeners -- pi.ts's no-cleanup design depends on this exact field name",
    );

    unsubscribe();
    assert.ok(
      !instance._eventListeners.includes(listener),
      'the unsubscribe closure returned by subscribe() must splice the listener back out of _eventListeners',
    );
  });
});
