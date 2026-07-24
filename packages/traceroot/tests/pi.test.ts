// Consolidated pi coverage: span construction, wrapper/integration behavior, config
// resolution, and the initialize()/wireInstrumentations() dispatch (merged from
// pi-spans.test.ts, pi-coding-agent.test.ts, and wiring-dispatch.test.ts).
// Lifecycle/event-ordering and edge-case coverage lives in pi-lifecycle-edge-cases.test.ts.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  resolveConfig,
  instrumentPiCodingAgent,
  describeToolCallSpan,
  openLlmSpan,
  closeLlmSpan,
  openToolSpan,
  closeToolSpan,
  sliceSurrogateSafe,
  type AgentEvent,
  type AssistantMessage,
} from '../src/pi';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { wireInstrumentations } from '../src/instrumentation';
import {
  assistantMessage,
  assistantMessage as baseAssistantMessage,
  attrs,
  CapturingExporter,
  makeFakeSessionClass,
  makeRig,
} from './pi-test-helpers';

// Shared by the dispose and steer/followUp describes below.
function registerCapturingProvider(capture: CapturingExporter): void {
  trace.disable();
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(capture));
  provider.register();
}

describe('pi span name', () => {
  it('describeToolCallSpan uses the file basename for path-like args', () => {
    assert.equal(describeToolCallSpan('read', { path: '/a/b/app.py' }), 'read: app.py');
    assert.equal(describeToolCallSpan('write', { file: 'notes.md' }), 'write: notes.md');
    assert.equal(describeToolCallSpan('edit', { filePath: 'src/x/y.ts' }), 'edit: y.ts');
    assert.equal(describeToolCallSpan('grep', { target: '/etc/hosts' }), 'grep: hosts');
    assert.equal(describeToolCallSpan('read', { file_path: '/a/b/app.py' }), 'read: app.py');
    assert.equal(describeToolCallSpan('read', { filename: 'notes.md' }), 'read: notes.md');
  });

  it('describeToolCallSpan summarizes bash by its (whitespace-collapsed) command and truncates a long one', () => {
    assert.equal(describeToolCallSpan('bash', { command: '  npm   test ' }), 'bash: npm test');
    const name = describeToolCallSpan('bash', { command: `echo ${'x'.repeat(200)}` });
    assert.ok(name.startsWith('bash: '));
    assert.ok(name.endsWith('…'));
    assert.ok(name.length <= 'bash: '.length + 60 + 1);
  });

  it('describeToolCallSpan falls back to the bare tool name', () => {
    assert.equal(describeToolCallSpan('think', {}), 'think');
    assert.equal(describeToolCallSpan('think', undefined), 'think');
    assert.equal(describeToolCallSpan('bash', { command: '' }), 'bash');
  });

  it('describeToolCallSpan ignores non-string path-like args', () => {
    assert.equal(describeToolCallSpan('read', { path: 42 }), 'read');
    assert.equal(describeToolCallSpan('read', { path: null }), 'read');
  });
});

describe('pi spans and config boundary coverage', () => {
  // Direct unit coverage of pi.ts's LLM/tool span helpers and sliceSurrogateSafe.
  function makeTracer() {
    const spans: ReadableSpan[] = [];
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(
      new SimpleSpanProcessor({
        export(batch, cb) {
          spans.push(...batch);
          cb({ code: 0 });
        },
        async shutdown() {},
      }),
    );
    const tracer = provider.getTracer('pi-spans-unit');
    return { tracer, spans };
  }

  it('closeLlmSpan emits ZERO-valued usage tokens as attributes (setAttr must not treat 0 as absent)', () => {
    const { tracer, spans } = makeTracer();
    const message = assistantMessage({
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const span = openLlmSpan(tracer, ROOT_CONTEXT, message);
    closeLlmSpan(span, message, true);

    const a = attrs(spans[0]!);
    assert.equal(a['gen_ai.usage.input_tokens'], 0);
    assert.equal(a['gen_ai.usage.output_tokens'], 0);
    assert.equal(a['gen_ai.usage.cache_read_input_tokens'], 0);
    assert.equal(a['gen_ai.usage.cache_creation_input_tokens'], 0);
    // OpenInference llm.* dual-write, zero must survive as an attribute here too.
    assert.equal(a['llm.token_count.prompt'], 0);
    assert.equal(a['llm.token_count.completion'], 0);
    assert.equal(a['llm.token_count.total'], 0);
    assert.equal(a['llm.token_count.prompt_details.cache_read'], 0);
    assert.equal(a['llm.token_count.prompt_details.cache_write'], 0);
  });

  it('closeLlmSpan maps cache tokens to the correct gen_ai keys (read<->cacheRead, creation<->cacheWrite)', () => {
    const { tracer, spans } = makeTracer();
    const message = assistantMessage({
      usage: {
        input: 5,
        output: 7,
        cacheRead: 11,
        cacheWrite: 13,
        totalTokens: 36,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const span = openLlmSpan(tracer, ROOT_CONTEXT, message);
    closeLlmSpan(span, message, false);

    const a = attrs(spans[0]!);
    assert.equal(a['gen_ai.usage.input_tokens'], 5);
    assert.equal(a['gen_ai.usage.output_tokens'], 7);
    assert.equal(a['gen_ai.usage.cache_read_input_tokens'], 11);
    assert.equal(a['gen_ai.usage.cache_creation_input_tokens'], 13);
    // OpenInference llm.* dual-write of the same numbers; total is pi's own totalTokens.
    assert.equal(a['llm.token_count.prompt'], 5);
    assert.equal(a['llm.token_count.completion'], 7);
    assert.equal(a['llm.token_count.total'], 36);
    assert.equal(a['llm.token_count.prompt_details.cache_read'], 11);
    assert.equal(a['llm.token_count.prompt_details.cache_write'], 13);
  });

  it('closeLlmSpan updates the span name to responseModel when it differs from the request model', () => {
    const { tracer, spans } = makeTracer();
    const message = assistantMessage({ model: 'claude-req', responseModel: 'claude-resp-dated' });
    const span = openLlmSpan(tracer, ROOT_CONTEXT, message);
    closeLlmSpan(span, message, false);
    assert.equal(spans[0]!.name, 'claude-resp-dated');
    assert.equal(attrs(spans[0]!)['gen_ai.response.model'], 'claude-resp-dated');
    assert.equal(attrs(spans[0]!)['llm.model_name'], 'claude-resp-dated');
  });

  it('openToolSpan swallows a circular-reference arg without setting input.value or throwing', () => {
    const { tracer, spans } = makeTracer();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    assert.doesNotThrow(() => {
      const span = openToolSpan(tracer, ROOT_CONTEXT, 'call-1', 'bash', circular, true);
      closeToolSpan(span, { ok: true }, false, true);
    });
    const toolSpan = spans.find((s) => attrs(s)['gen_ai.tool.call.id'] === 'call-1');
    assert.ok(toolSpan);
    assert.equal(
      attrs(toolSpan!)['input.value'],
      undefined,
      'a circular arg must be skipped (caught), not partially serialized',
    );
    assert.equal(attrs(toolSpan!)['output.value'], JSON.stringify({ ok: true }));
  });

  it('sliceSurrogateSafe returns text unchanged when at or under maxLen (<=, not <)', () => {
    assert.equal(sliceSurrogateSafe('hello', 5), 'hello');
    assert.equal(sliceSurrogateSafe('hello', 10), 'hello');
    assert.equal(sliceSurrogateSafe('', 0), '');
  });

  it('sliceSurrogateSafe backs off one code unit when a high surrogate sits at the cut boundary', () => {
    const emoji = '\u{1F600}';
    const text = `abc${emoji}tail`;
    const sliced = sliceSurrogateSafe(text, 4);
    assert.equal(sliced, 'abc');
    const lastCode = sliced.charCodeAt(sliced.length - 1);
    assert.ok(lastCode < 0xd800 || lastCode > 0xdbff, 'must not end on an unpaired high surrogate');
  });
});

describe('pi spans truncation', () => {
  // Mirrors src/pi.ts's MAX_TOOL_IO_JSON_CHARS (not exported).
  const MAX_TOOL_IO_JSON_CHARS = 32 * 1024;

  // Mirrors src/pi.ts's capJsonWithMarker marker text exactly.
  const TRUNCATION_MARKER = '…[truncated]';

  // Drives one tool call through the full instrumented event sequence and returns the exported TOOL span.
  async function runToolCall(
    args: unknown,
    result: unknown,
    config: { captureToolIo?: boolean } = {},
  ): Promise<ReadableSpan> {
    const { capture, Session } = makeRig(config);
    const session = new Session();

    const done = session.prompt('run a tool');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage() });
    session.emit({ type: 'message_end', message: assistantMessage() });
    session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result,
      isError: false,
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const toolSpan = capture.spans.find(
      (s) => (s.attributes as Record<string, unknown>)['gen_ai.tool.call.id'] === 't1',
    );
    assert.ok(toolSpan, 'expected a tool span to have been exported');
    return toolSpan!;
  }

  // JSON.stringify overhead for a single-key { data: '' } object, computed at runtime.
  const JSON_WRAPPER_OVERHEAD = JSON.stringify({ data: '' }).length;

  function payloadOfExactJsonLength(totalLength: number, filler = 'x'): { data: string } {
    const fillerLength = totalLength - JSON_WRAPPER_OVERHEAD;
    assert.ok(fillerLength >= 0, 'requested JSON length is smaller than the wrapper overhead');
    return { data: filler.repeat(fillerLength) };
  }

  it('a tool arg/result under the cap passes through openToolSpan/closeToolSpan unchanged', async () => {
    const args = { command: 'echo hello', note: 'small arg' };
    const result = { content: [{ type: 'text', text: 'hello' }] };
    const toolSpan = await runToolCall(args, result);

    assert.equal(attrs(toolSpan)['input.value'], JSON.stringify(args));
    assert.equal(attrs(toolSpan)['output.value'], JSON.stringify(result));
    assert.ok(!String(attrs(toolSpan)['input.value']).includes(TRUNCATION_MARKER));
    assert.ok(!String(attrs(toolSpan)['output.value']).includes(TRUNCATION_MARKER));
  });

  it('a tool arg/result exactly at the cap boundary passes through unchanged (<=, not <)', async () => {
    const args = payloadOfExactJsonLength(MAX_TOOL_IO_JSON_CHARS);
    const result = payloadOfExactJsonLength(MAX_TOOL_IO_JSON_CHARS, 'y');
    assert.equal(
      JSON.stringify(args).length,
      MAX_TOOL_IO_JSON_CHARS,
      'sanity check on args length',
    );
    assert.equal(
      JSON.stringify(result).length,
      MAX_TOOL_IO_JSON_CHARS,
      'sanity check on result length',
    );

    const toolSpan = await runToolCall(args, result);

    assert.equal(attrs(toolSpan)['input.value'], JSON.stringify(args));
    assert.equal(attrs(toolSpan)['output.value'], JSON.stringify(result));
    assert.equal((attrs(toolSpan)['input.value'] as string).length, MAX_TOOL_IO_JSON_CHARS);
    assert.equal((attrs(toolSpan)['output.value'] as string).length, MAX_TOOL_IO_JSON_CHARS);
    assert.ok(!(attrs(toolSpan)['input.value'] as string).includes(TRUNCATION_MARKER));
    assert.ok(!(attrs(toolSpan)['output.value'] as string).includes(TRUNCATION_MARKER));
  });

  it('a tool arg/result over the cap is truncated with the marker appended, total length within bound', async () => {
    const args = payloadOfExactJsonLength(MAX_TOOL_IO_JSON_CHARS + 1000);
    const result = payloadOfExactJsonLength(MAX_TOOL_IO_JSON_CHARS + 500, 'y');

    const toolSpan = await runToolCall(args, result);

    const inputValue = attrs(toolSpan)['input.value'] as string;
    const outputValue = attrs(toolSpan)['output.value'] as string;

    assert.ok(inputValue.endsWith(TRUNCATION_MARKER), 'input.value must end with the marker');
    assert.ok(outputValue.endsWith(TRUNCATION_MARKER), 'output.value must end with the marker');

    assert.ok(
      inputValue.length <= MAX_TOOL_IO_JSON_CHARS + TRUNCATION_MARKER.length,
      'input.value total length must stay within MAX + marker bound',
    );
    assert.ok(
      outputValue.length <= MAX_TOOL_IO_JSON_CHARS + TRUNCATION_MARKER.length,
      'output.value total length must stay within MAX + marker bound',
    );
    assert.equal(inputValue.length, MAX_TOOL_IO_JSON_CHARS + TRUNCATION_MARKER.length);
    assert.equal(outputValue.length, MAX_TOOL_IO_JSON_CHARS + TRUNCATION_MARKER.length);
    assert.equal(
      inputValue,
      JSON.stringify(args).slice(0, MAX_TOOL_IO_JSON_CHARS) + TRUNCATION_MARKER,
    );
    assert.equal(
      outputValue,
      JSON.stringify(result).slice(0, MAX_TOOL_IO_JSON_CHARS) + TRUNCATION_MARKER,
    );
  });

  it('captureToolIo: false still bypasses capJsonWithMarker entirely (no marker, no attribute)', async () => {
    const args = payloadOfExactJsonLength(MAX_TOOL_IO_JSON_CHARS + 1000);
    const toolSpan = await runToolCall(args, {}, { captureToolIo: false });

    assert.equal(attrs(toolSpan)['input.value'], undefined);
    assert.equal(attrs(toolSpan)['output.value'], undefined);
  });

  it('captureToolIo: false keeps arg-derived content out of the tool span NAME, not just its attributes (H1)', async () => {
    const secret = 'curl -H "Authorization: Bearer sk-live-SECRET123" https://internal/x';

    const withCapture = await runToolCall({ command: secret }, {}, { captureToolIo: true });
    assert.ok(
      (withCapture.name as string).startsWith('bash: '),
      'with capture on, the name still summarizes the command',
    );

    const noCapture = await runToolCall({ command: secret }, {}, { captureToolIo: false });
    assert.equal(noCapture.name, 'bash', 'with capture off, the name must be the bare tool name');
    assert.ok(
      !String(noCapture.name).includes('SECRET123'),
      'a secret in the command must never reach the span name when captureToolIo is off',
    );
  });

  it('tool spans dual-write OpenInference tool.name alongside gen_ai.tool.name (M2)', async () => {
    const toolSpan = await runToolCall({ command: 'echo hi' }, {});
    assert.equal(attrs(toolSpan)['tool.name'], 'bash', 'OpenInference tool.name must be set');
    assert.equal(attrs(toolSpan)['gen_ai.tool.name'], 'bash');
  });

  it('a WIDE tool payload (more entries than the breadth cap) is truncated by entry count, not fully serialized (M1)', async () => {
    // Small per-element so the FULL array is well under the byte cap; only the entry-count
    // cap can produce this truncation, which distinguishes the M1 fix from the pre-existing
    // whole-payload byte cap.
    const wide = Array.from({ length: 2500 }, (_, i) => `x${i}`);
    const toolSpan = await runToolCall({ items: wide }, {});
    const inputValue = attrs(toolSpan)['input.value'] as string;

    assert.ok(inputValue.includes(TRUNCATION_MARKER), 'the breadth cap marks the truncation');
    assert.ok(
      !inputValue.includes('"x2499"'),
      'the far-tail element beyond the cap must be dropped, not serialized',
    );
    assert.ok(
      inputValue.length <= MAX_TOOL_IO_JSON_CHARS + TRUNCATION_MARKER.length,
      'input.value stays within the size bound',
    );
  });
});

describe('pi config resolution', () => {
  it('resolveConfig() defaults captureContent and captureToolIo to true when omitted', () => {
    const resolved = resolveConfig();
    assert.equal(resolved.captureContent, true);
    assert.equal(resolved.captureToolIo, true);

    const resolvedFromEmptyObject = resolveConfig({});
    assert.equal(resolvedFromEmptyObject.captureContent, true);
    assert.equal(resolvedFromEmptyObject.captureToolIo, true);
  });

  it('resolveConfig() respects explicit false overrides for captureContent and captureToolIo independently', () => {
    const contentOff = resolveConfig({ captureContent: false });
    assert.equal(contentOff.captureContent, false);
    assert.equal(contentOff.captureToolIo, true, 'captureToolIo must keep its own default');

    const toolIoOff = resolveConfig({ captureToolIo: false });
    assert.equal(toolIoOff.captureContent, true, 'captureContent must keep its own default');
    assert.equal(toolIoOff.captureToolIo, false);

    const bothOff = resolveConfig({ captureContent: false, captureToolIo: false });
    assert.equal(bothOff.captureContent, false);
    assert.equal(bothOff.captureToolIo, false);
  });
});

describe('pi instrumentation', () => {
  // Overrides the shared helper's placeholder usage since this file asserts on specific numbers.
  function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
    return baseAssistantMessage({
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0.001, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.0016 },
      },
      ...overrides,
    });
  }

  it('a full turn with one tool call produces a correctly nested AGENT -> LLM -> TOOL span tree', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    // NOT awaited yet; see pi-test-helpers CONTRACT.
    const done = session.prompt('list files in /tmp');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'turn_start' });
    session.emit({ type: 'message_start', message: assistantMessage() });
    session.emit({
      type: 'message_end',
      message: assistantMessage({
        content: [
          { type: 'text', text: "I'll list the files now." },
          { type: 'toolCall', id: 't1', name: 'bash' },
        ],
      }),
    });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'ls /tmp' },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'a.txt' }] },
      isError: false,
    });
    session.emit({
      type: 'turn_end',
      message: assistantMessage(),
      toolResults: [],
    });
    session.emit({
      type: 'agent_end',
      messages: [assistantMessage({ content: [{ type: 'text', text: 'listed the files' }] })],
      willRetry: false,
    });
    await done;

    assert.equal(capture.spans.length, 3, 'expected exactly root, LLM, and tool spans');

    const [llmSpan, toolSpan, rootSpan] = capture.spans;

    assert.equal(rootSpan.name, 'AgentSession.prompt');
    assert.equal(attrs(rootSpan)['openinference.span.kind'], 'AGENT');
    assert.equal(attrs(rootSpan)['session.id'], 'sess-1');
    // traceroot.sdk.name is owned by TraceRootSpanProcessor, which this rig doesn't wire.
    assert.equal(attrs(rootSpan)['traceroot.sdk.name'], undefined);
    assert.equal(attrs(rootSpan)['input.value'], 'list files in /tmp');
    assert.equal(attrs(rootSpan)['output.value'], 'listed the files');
    assert.equal(attrs(rootSpan)['traceroot.pi.retry_count'], 0);

    assert.equal(attrs(llmSpan)['openinference.span.kind'], 'LLM');
    assert.equal(attrs(llmSpan)['gen_ai.system'], 'anthropic');
    assert.equal(attrs(llmSpan)['gen_ai.request.model'], 'claude-sonnet-5');
    assert.equal(attrs(llmSpan)['gen_ai.usage.input_tokens'], 100);
    assert.equal(attrs(llmSpan)['gen_ai.usage.output_tokens'], 20);
    assert.equal(
      attrs(llmSpan)['output.value'],
      "I'll list the files now.",
      'captureContent:true (the default) must populate output.value on the LLM span too, not just the root span',
    );
    assert.equal(
      llmSpan.parentSpanId,
      rootSpan.spanContext().spanId,
      'LLM span must be a child of the root span',
    );

    assert.equal(toolSpan.name, 'bash: ls /tmp');
    assert.equal(attrs(toolSpan)['openinference.span.kind'], 'TOOL');
    assert.equal(attrs(toolSpan)['gen_ai.tool.name'], 'bash');
    assert.equal(attrs(toolSpan)['gen_ai.tool.call.id'], 't1');
    assert.equal(
      toolSpan.parentSpanId,
      llmSpan.spanContext().spanId,
      'tool span must be a child of the LLM span that requested it, not a sibling under root',
    );
  });

  it('two concurrent tool calls in one turn each get their own correctly-keyed span', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('do two things');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage() });
    session.emit({ type: 'message_end', message: assistantMessage() });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'a',
      toolName: 'read',
      args: { path: '/x.txt' },
    });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'b',
      toolName: 'read',
      args: { path: '/y.txt' },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'b',
      toolName: 'read',
      result: {},
      isError: false,
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'a',
      toolName: 'read',
      result: {},
      isError: false,
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const toolSpans = capture.spans.filter(
      (s) => (s.attributes as Record<string, unknown>)['gen_ai.tool.call.id'],
    );
    assert.equal(toolSpans.length, 2);
    const ids = toolSpans
      .map((s) => (s.attributes as Record<string, unknown>)['gen_ai.tool.call.id'])
      .sort();
    assert.deepEqual(ids, ['a', 'b']);
    assert.equal(toolSpans[0]!.name, 'read: y.txt', 'b ended first, so it should export first');
    assert.equal(toolSpans[1]!.name, 'read: x.txt');
  });

  it('a failed LLM turn (stopReason error) marks the LLM span as ERROR', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('trigger a provider error');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage() });
    session.emit({
      type: 'message_end',
      message: assistantMessage({ stopReason: 'error', errorMessage: 'rate limited' }),
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const llmSpan = capture.spans.find(
      (s) => (s.attributes as Record<string, unknown>)['openinference.span.kind'] === 'LLM',
    );
    assert.ok(llmSpan);
    assert.equal(llmSpan!.status.code, 2 /* SpanStatusCode.ERROR */);
    assert.equal(llmSpan!.status.message, 'rate limited');
  });

  it('a failed tool call (isError) marks the TOOL span as ERROR', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('run a failing command');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage() });
    session.emit({ type: 'message_end', message: assistantMessage() });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'false' },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'exit 1' }] },
      isError: true,
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const toolSpan = capture.spans.find(
      (s) => (s.attributes as Record<string, unknown>)['gen_ai.tool.call.id'] === 't1',
    );
    assert.ok(toolSpan);
    assert.equal(toolSpan!.status.code, 2 /* SpanStatusCode.ERROR */);
  });

  it('captureContent: false suppresses input.value/output.value but keeps other attributes', async () => {
    const { capture, Session } = makeRig({ captureContent: false });
    const session = new Session();

    const done = session.prompt('sensitive prompt text');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage() });
    session.emit({
      type: 'message_end',
      message: assistantMessage({ content: [{ type: 'text', text: 'sensitive llm reply' }] }),
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({
      type: 'agent_end',
      messages: [assistantMessage({ content: [{ type: 'text', text: 'sensitive reply' }] })],
      willRetry: false,
    });
    await done;

    const [llmSpan, rootSpan] = capture.spans;
    assert.equal(attrs(rootSpan!)['input.value'], undefined);
    assert.equal(attrs(rootSpan!)['output.value'], undefined);
    assert.equal(attrs(rootSpan!)['session.id'], 'sess-1');

    assert.ok(llmSpan, 'expected an LLM span to have been captured');
    assert.equal(attrs(llmSpan!)['openinference.span.kind'], 'LLM');
    assert.equal(
      attrs(llmSpan!)['output.value'],
      undefined,
      'captureContent:false must suppress output.value on the LLM span too, not just the root span',
    );
  });

  it('captureToolIo: false suppresses tool input/output AND arg-derived content in the span name (H1)', async () => {
    const { capture, Session } = makeRig({ captureToolIo: false });
    const session = new Session();

    const done = session.prompt('run a tool');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: assistantMessage() });
    session.emit({ type: 'message_end', message: assistantMessage() });
    // A path arg (tool IO): with captureToolIo off, the name must fall back to the bare
    // tool name — no basename, no filename — so nothing arg-derived leaks into it.
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'read',
      args: { path: '/Users/alice/secret-project/notes.txt' },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'read',
      result: { secret: 'leaked?' },
      isError: false,
    });
    session.emit({ type: 'turn_end', message: assistantMessage(), toolResults: [] });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    const toolSpan = capture.spans.find(
      (s) => (s.attributes as Record<string, unknown>)['gen_ai.tool.call.id'] === 't1',
    );
    assert.ok(toolSpan);
    assert.equal(attrs(toolSpan!)['input.value'], undefined);
    assert.equal(attrs(toolSpan!)['output.value'], undefined);
    assert.equal(attrs(toolSpan!)['gen_ai.tool.name'], 'read');
    assert.equal(toolSpan!.name, 'read', 'the name is the bare tool name, not the file basename');
    assert.ok(
      !toolSpan!.name.includes('notes.txt') && !toolSpan!.name.includes('secret-project'),
      'no part of the path (filename or directory) may appear in the span name when capture is off',
    );
  });

  it('an early-return prompt() call (resolved with no agent_start/agent_end) exports exactly one childless, OK-status AGENT root span', async () => {
    const { capture, Session } = makeRig();
    const session = new Session();

    const done = session.prompt('a handled slash command');
    session.resolvePrompt();
    await assert.doesNotReject(() => done);

    assert.equal(
      capture.spans.length,
      1,
      'exactly one span: the root, with ZERO child spans (no agent_start ever fired to open any)',
    );
    const rootSpan = capture.spans[0]!;
    assert.equal(rootSpan.name, 'AgentSession.prompt');
    assert.equal(attrs(rootSpan)['openinference.span.kind'], 'AGENT');
    assert.equal(
      rootSpan.status.code,
      1 /* SpanStatusCode.OK */,
      'finalize() explicitly stamps OK on a resolved call (a successfully-resolved ' +
        'promise, even with zero children, is not merely "unset")',
    );
    assert.equal(
      rootSpan.parentSpanId,
      undefined,
      'the root itself has no parent (it is the trace root)',
    );
  });
});

describe('pi wiring and wireInstrumentations() dispatch', () => {
  // A fake `import * as pi from '@earendil-works/pi-coding-agent'` namespace. The
  // real in-tree pi instrumentation patches AgentSession.prototype.prompt when
  // wired, so a change in that method's identity is a reliable "pi was actually
  // instrumented" signal without having to drive a whole agent turn.
  function makePiModule() {
    class FakeAgentSession {
      sessionId = 'core-wiring-sess';
      async prompt(_text: string): Promise<void> {}
      subscribe(_listener: (event: { type: string }) => void): () => void {
        return () => {};
      }
      dispose(): void {}
    }
    return { AgentSession: FakeAgentSession };
  }

  function piPromptPatched(mod: ReturnType<typeof makePiModule>, original: unknown): boolean {
    return mod.AgentSession.prototype.prompt !== original;
  }

  // A minimally-valid @anthropic-ai/claude-agent-sdk namespace: a mutable object
  // exposing query(). wireClaudeAgentSDKInstrumentation() replaces .query in place.
  function makeClaudeModule() {
    return {
      query(_params: unknown): AsyncIterable<unknown> {
        return { async *[Symbol.asyncIterator]() {} };
      },
    };
  }

  const BASE = {
    apiKey: 'trk_core_wiring',
    baseUrl: 'http://127.0.0.1:9',
    disableBatch: true as const,
    gitRepo: 'traceroot-ai/traceroot-ts',
    gitRef: 'core-wiring-ref',
  };

  afterEach(() => {
    _resetForTesting();
    delete process.env.TRACEROOT_API_KEY;
  });

  describe('instrumentModules.piCodingAgent wiring', () => {
    it('accepts the { module, config } wrapper form and still patches the prototype', () => {
      const pi = makePiModule();
      const originalPrompt = pi.AgentSession.prototype.prompt;

      TraceRoot.initialize({
        ...BASE,
        instrumentModules: {
          piCodingAgent: { module: pi, config: { captureContent: false } },
        },
      });

      assert.equal(TraceRoot.isInitialized(), true);
      assert.notStrictEqual(
        pi.AgentSession.prototype.prompt,
        originalPrompt,
        'the { module, config } wrapper must be unwrapped and still patch the prototype',
      );
    });

    it('leaves the prototype untouched when piCodingAgent is null', () => {
      const pi = makePiModule();
      const originalPrompt = pi.AgentSession.prototype.prompt;

      TraceRoot.initialize({ ...BASE, instrumentModules: { piCodingAgent: null } });

      assert.equal(TraceRoot.isInitialized(), true);
      assert.strictEqual(
        pi.AgentSession.prototype.prompt,
        originalPrompt,
        'a null piCodingAgent must never touch any AgentSession prototype',
      );
    });

    it('throws and rolls initialize() back for a misshapen module (fail loudly, like claude-agent-sdk)', () => {
      // No prompt/subscribe on the prototype: a pi SDK rename must fail loudly, not silently emit zero traces.
      const misshapen = { AgentSession: class {} };

      assert.throws(
        () => TraceRoot.initialize({ ...BASE, instrumentModules: { piCodingAgent: misshapen } }),
        /prompt\/subscribe not found/,
        'a misshapen piCodingAgent must throw, not warn-and-noop',
      );
      assert.equal(
        TraceRoot.isInitialized(),
        false,
        'the wiring-failure rollback must leave TraceRoot uninitialized (it never reached _isInitialized = true)',
      );
    });
  });

  describe('wireInstrumentations() dispatch — sibling isolation', () => {
    it('throws a clear diagnostic when claudeAgentSDK is passed without query()', () => {
      assert.throws(
        () => wireInstrumentations({ claudeAgentSDK: {} }),
        /does not expose query/,
        'a claudeAgentSDK ref without query() must throw an actionable error',
      );
    });

    it('a throwing claudeAgentSDK aborts the loop before a co-passed piCodingAgent is wired', () => {
      // Documents the blast radius: because wireInstrumentations() wires
      // claudeAgentSDK before piCodingAgent and does not isolate per-module
      // failures, a bad claudeAgentSDK throws out of the whole loop and a
      // perfectly valid piCodingAgent alongside it is silently left
      // un-instrumented.
      delete process.env.TRACEROOT_API_KEY;
      const pi = makePiModule();
      const originalPrompt = pi.AgentSession.prototype.prompt;

      let threw = false;
      try {
        TraceRoot.initialize({
          ...BASE,
          instrumentModules: { claudeAgentSDK: {}, piCodingAgent: pi },
        });
      } catch {
        threw = true;
      }
      assert.equal(threw, true);
      assert.equal(
        piPromptPatched(pi, originalPrompt),
        false,
        'the valid piCodingAgent was left un-instrumented because the claudeAgentSDK throw aborted the loop',
      );
    });
  });

  describe('both piCodingAgent and claudeAgentSDK in one initialize() call', () => {
    it('wires both when both are valid, with no interference', () => {
      delete process.env.TRACEROOT_API_KEY;
      const pi = makePiModule();
      const originalPrompt = pi.AgentSession.prototype.prompt;
      const claude = makeClaudeModule();
      const originalQuery = claude.query;

      TraceRoot.initialize({
        ...BASE,
        instrumentModules: { claudeAgentSDK: claude, piCodingAgent: pi },
      });

      assert.equal(TraceRoot.isInitialized(), true);
      assert.notStrictEqual(
        claude.query,
        originalQuery,
        'claudeAgentSDK.query must be wrapped in place',
      );
      assert.equal(
        piPromptPatched(pi, originalPrompt),
        true,
        'piCodingAgent must be instrumented alongside claudeAgentSDK',
      );
    });
  });

  describe('double initialize() without an intervening shutdown()', () => {
    it("drops the second call's instrumentModules (documented Already-initialized guard)", () => {
      delete process.env.TRACEROOT_API_KEY;

      // First init with no instrumentModules.
      TraceRoot.initialize({ ...BASE });
      assert.equal(TraceRoot.isInitialized(), true);

      // Second init supplies a valid piCodingAgent. The Already-initialized guard
      // returns early, so this config is intentionally NOT applied. This confirms
      // the documented contract (a second initialize() is a warned no-op), rather
      // than the alternative one might expect (the new config being merged/applied).
      const pi = makePiModule();
      const originalPrompt = pi.AgentSession.prototype.prompt;
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(' '));
      };
      try {
        TraceRoot.initialize({ ...BASE, instrumentModules: { piCodingAgent: pi } });
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(
        piPromptPatched(pi, originalPrompt),
        false,
        "the second initialize()'s instrumentModules must be dropped by the Already-initialized guard",
      );
      assert.ok(
        warnings.some((w) => w.includes('Already initialized')),
        'the dropped second initialize() must warn that it was skipped',
      );
    });
  });
});

describe('pi integration', () => {
  // Drives the real pi instrumentation through TraceRoot.initialize() with no mocked pi export.

  // Reaches the provider TraceRoot.initialize() registered as the OTel global delegate.
  function attachInMemoryExporterToGlobalProvider(): InMemorySpanExporter {
    const proxy = trace.getTracerProvider() as { getDelegate?: () => unknown };
    const delegate = (typeof proxy.getDelegate === 'function' ? proxy.getDelegate() : proxy) as {
      addSpanProcessor(processor: SimpleSpanProcessor): void;
    };
    const exporter = new InMemorySpanExporter();
    delegate.addSpanProcessor(new SimpleSpanProcessor(exporter));
    return exporter;
  }

  const spanKind = (span: ReadableSpan): unknown => attrs(span)['openinference.span.kind'];

  afterEach(() => {
    _resetForTesting();
  });

  it('the real in-tree pi instrumentation wired through TraceRoot.initialize exports enriched spans into TraceRoot own pipeline', async () => {
    delete process.env.TRACEROOT_API_KEY;

    const Session = makeFakeSessionClass();
    const pi = { AgentSession: Session };

    TraceRoot.initialize({
      apiKey: 'trk_integration_key',
      // Local, unroutable: must never POST to the real backend.
      baseUrl: 'http://127.0.0.1:9',
      disableBatch: true,
      environment: 'integration-test',
      gitRepo: 'traceroot-ai/traceroot-ts',
      gitRef: 'integration-ref',
      instrumentModules: { piCodingAgent: pi },
    });
    assert.equal(TraceRoot.isInitialized(), true);

    const captured = attachInMemoryExporterToGlobalProvider();

    const session = new Session();
    (session as { sessionId: string }).sessionId = 'integration-sess';
    const working = assistantMessage({ content: [{ type: 'text', text: 'working on it' }] });
    const done = session.prompt('summarize the repository');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'turn_start' });
    session.emit({ type: 'message_start', message: working });
    session.emit({ type: 'message_end', message: working });
    session.emit({ type: 'turn_end', message: working, toolResults: [] });
    session.emit({
      type: 'agent_end',
      messages: [
        assistantMessage({
          content: [{ type: 'text', text: 'the repository has three packages' }],
        }),
      ],
      willRetry: false,
    });
    await done;

    const spans = captured.getFinishedSpans();
    const rootSpan = spans.find((s) => spanKind(s) === 'AGENT');
    const llmSpan = spans.find((s) => spanKind(s) === 'LLM');

    assert.ok(
      rootSpan,
      'the real in-tree pi instrumentation must export an AGENT root span through TraceRoot shared provider',
    );

    assert.equal(rootSpan!.name, 'AgentSession.prompt');
    assert.equal(attrs(rootSpan!)['session.id'], 'integration-sess');
    assert.equal(attrs(rootSpan!)['input.value'], 'summarize the repository');
    assert.equal(attrs(rootSpan!)['output.value'], 'the repository has three packages');
    // traceroot.sdk.name is owned by TraceRootSpanProcessor.onStart, uniformly across every span.
    assert.equal(attrs(rootSpan!)['traceroot.sdk.name'], 'traceroot-ts');

    assert.equal(attrs(rootSpan!)['deployment.environment'], 'integration-test');
    assert.equal(attrs(rootSpan!)['traceroot.git.repo'], 'traceroot-ai/traceroot-ts');
    assert.equal(attrs(rootSpan!)['traceroot.git.ref'], 'integration-ref');
    assert.deepEqual(
      attrs(rootSpan!)['traceroot.span.path'],
      ['AgentSession.prompt'],
      'the root span must carry TraceRootSpanProcessor span-path enrichment',
    );

    assert.ok(llmSpan, 'the LLM child span must also route through TraceRoot provider');
    assert.equal(
      llmSpan!.parentSpanId,
      rootSpan!.spanContext().spanId,
      'the LLM span must nest under the AGENT root span',
    );
    assert.deepEqual(
      attrs(llmSpan!)['traceroot.span.path'],
      ['AgentSession.prompt', 'claude-sonnet-5'],
      'the LLM span path must chain off the root span path via TraceRootSpanProcessor',
    );
  });
});

describe('pi session dispose', () => {
  // dispose() clears every listener via subscribe(), reassigning the internal array to a fresh
  // empty one. Local instrumentPiCodingAgent() calls (not makeRig()) so tests can drive
  // dispose() on the raw session.

  it('dispose() mid-run (before agent_end) force-closes and exports any still-open AGENT/LLM/TOOL spans instead of leaking them', async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    // "Host disposes mid-run": open spans, never fire agent_end. Not awaited: abandoned mid-flight.
    session.prompt('long-running task');
    session.emit({ type: 'agent_start' });
    session.emit({
      type: 'message_start',
      message: assistantMessage({ model: 'mid-run-model' }),
    });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: { path: '/tmp/x' },
    });

    assert.equal(
      capture.spans.length,
      0,
      'no span should export before dispose() while still open',
    );

    assert.doesNotThrow(() => {
      session.dispose();
    }, 'dispose() must never throw even though it now force-closes in-flight spans');
    assert.equal(
      session.disposed,
      true,
      'the real dispose() must still run and mark the session disposed',
    );

    assert.equal(
      capture.spans.length,
      3,
      'the open AGENT root span, LLM span, and TOOL span must all be force-closed and exported by dispose()',
    );

    const rootSpan = capture.spans.find((s) => s.name === 'AgentSession.prompt');
    const llmSpan = capture.spans.find((s) => attrs(s)['gen_ai.request.model'] === 'mid-run-model');
    const toolSpan = capture.spans.find((s) => attrs(s)['gen_ai.tool.call.id'] === 'call-1');

    assert.ok(rootSpan, 'the AGENT root span must be exported');
    assert.ok(llmSpan, 'the LLM span must be exported');
    assert.ok(toolSpan, 'the TOOL span must be exported');

    assert.equal(
      attrs(rootSpan!)['traceroot.pi.force_closed'],
      true,
      'the root span must be marked force_closed, distinguishing it from a normal agent_end close',
    );
    assert.equal(
      attrs(llmSpan!)['traceroot.pi.force_closed'],
      true,
      'the LLM span must be marked force_closed',
    );
    assert.equal(
      attrs(toolSpan!)['traceroot.pi.force_closed'],
      true,
      'the TOOL span must be marked force_closed',
    );

    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    assert.equal(
      capture.spans.length,
      3,
      'no further spans may appear after dispose() already force-closed everything',
    );
  });

  // Guards a real bug: subscribedSessions used to permanently remember a session as subscribed
  // and never re-attach its listener after dispose(), so every run after the first dispose() produced zero spans.
  it('a session reused after dispose() re-subscribes and resumes tracing on its next prompt()', async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    const done1 = session.prompt('first run');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done1;
    assert.equal(capture.spans.length, 1, 'the first run must export its span');

    session.dispose();
    assert.equal(session.disposed, true);

    const done2 = session.prompt('second run, after dispose()');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done2;

    assert.equal(
      capture.spans.length,
      2,
      'the second run (after dispose() and reuse) must ALSO export its span, not be silently ' +
        'dropped because instrumentPiCodingAgent() thinks this session is still subscribed',
    );
  });

  // Guards a reentrancy race: a host listener registered before pi's own that calls dispose()
  // synchronously on agent_end force-closes the root before pi's own agent_end handler runs.
  it('agent_end after a reentrant dispose() force-closed the root still exports it exactly once', async () => {
    const capture = new CapturingExporter();
    const Session = makeFakeSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    // Registered before pi's own subscribe() (below), so it sits ahead of pi's handler.
    session.subscribe((event: AgentEvent) => {
      if (event.type === 'agent_end') session.dispose();
    });

    const done = session.prompt('do the work'); // pi subscribes here, after the host
    session.emit({ type: 'agent_start' });
    session.emit({
      type: 'agent_end',
      messages: [assistantMessage({ content: [{ type: 'text', text: 'the final answer' }] })],
      willRetry: false,
    });
    await done;

    assert.equal(
      capture.spans.length,
      1,
      'the root span is force-closed exactly once by dispose()',
    );
    const rootSpan = capture.spans[0];
    assert.equal(attrs(rootSpan)['openinference.span.kind'], 'AGENT');
    assert.equal(
      attrs(rootSpan)['traceroot.pi.force_closed'],
      true,
      'dispose() force-closed the root span, so it is marked force_closed',
    );
    assert.equal(
      attrs(rootSpan)['output.value'],
      undefined,
      "the run's completion output never made it onto the force-closed root span",
    );
  });
});

describe('pi steer / followUp', () => {
  // Must patch .steer/.followUp too, not just .prompt: real bug was a host whose first interaction
  // was steer()/followUp() got zero tracing. Their text is deliberately never asserted onto the root's
  // input.value: they only enqueue, never trigger a run, so attributing it would misattribute to a later run.

  // Extends the shared FakeAgentSession with steer()/followUp(). Fresh per call so patches don't stack.
  function makeSteerAndFollowUpSessionClass() {
    const Base = makeFakeSessionClass();
    return class SteerAndFollowUpAgentSession extends Base {
      async steer(_text: string, _images?: unknown[]): Promise<void> {}
      async followUp(_text: string, _images?: unknown[]): Promise<void> {}
    };
  }

  // Only prompt() opens a root span; a steer()-only run produces none, so this checks its tool span
  // still exports (as a parentless mini-trace) to prove the listener is attached, not zero-tracing.
  it('calling steer() as the FIRST interaction (no prior prompt() call) still attaches tracing -- its run is ROOTLESS (bypasses prompt()), but its child spans still export', async () => {
    const capture = new CapturingExporter();
    const Session = makeSteerAndFollowUpSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    await session.steer('do X instead');
    session.emit({ type: 'agent_start' });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'bypass-tool',
      toolName: 'bash',
      args: {},
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'bypass-tool',
      toolName: 'bash',
      result: {},
      isError: false,
    });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });

    assert.equal(
      capture.spans.find((s) => attrs(s)['openinference.span.kind'] === 'AGENT'),
      undefined,
      'a run that bypasses prompt() entirely must never synthesize a root AGENT span',
    );
    const toolSpan = capture.spans.find((s) => attrs(s)['gen_ai.tool.call.id'] === 'bypass-tool');
    assert.ok(
      toolSpan,
      "steer() must still attach the span listener itself -- otherwise this bypass run's tool span " +
        'would never have been captured at all, proving prompt() was not required first',
    );
    assert.equal(
      toolSpan!.parentSpanId,
      undefined,
      "with no root open, the bypass run's tool span parents under ROOT_CONTEXT (a fresh, " +
        'standalone parentless mini-trace)',
    );
  });

  it('a session already subscribed via prompt() does not get double-subscribed when steer()/followUp() are called later', async () => {
    const capture = new CapturingExporter();
    const Session = makeSteerAndFollowUpSessionClass();
    const sdk = { AgentSession: Session };
    registerCapturingProvider(capture);
    instrumentPiCodingAgent(sdk, {});
    const session = new Session();

    const done = session.prompt('start the run');
    await session.steer('steer mid-run');
    await session.followUp('follow up after');
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    await done;

    assert.equal(
      capture.spans.length,
      1,
      'exactly one root span -- proves steer()/followUp() reused the same listener prompt() already attached, instead of subscribing a second time',
    );
  });
});
