import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { wireInstrumentations } from '../src/instrumentation';
import { wireLiveKitInstrumentation } from '../src/livekit';
import { TraceRootSpanProcessor } from '../src/processor';
import { TraceRoot, _resetForTesting } from '../src/traceroot';

describe('LiveKit export overlay', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new TraceRootSpanProcessor(new SimpleSpanProcessor(exporter)));
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
  });

  it('maps LiveKit agent_turn spans to agent kind and IO', () => {
    const tracer = provider.getTracer('livekit-agents');

    const span = tracer.startSpan('agent_turn');
    span.setAttribute('lk.user_input', 'Tell me a joke.');
    span.setAttribute('lk.response.text', 'Why did the test pass?');
    span.end();

    const [finished] = exporter.getFinishedSpans();
    assert.equal(finished.attributes['openinference.span.kind'], 'AGENT');
    assert.equal(finished.attributes['input.value'], 'Tell me a joke.');
    assert.equal(finished.attributes['output.value'], 'Why did the test pass?');
  });

  it('maps LiveKit llm_request spans to llm kind, model, tokens, and IO', () => {
    const tracer = provider.getTracer('livekit-agents');

    const span = tracer.startSpan('llm_request');
    span.setAttribute('lk.chat_ctx', 'user: hello');
    span.setAttribute('lk.response.text', 'assistant: hi');
    span.setAttribute('gen_ai.request.model', 'openai/gpt-5.2-chat-latest');
    span.setAttribute('gen_ai.usage.input_tokens', 11);
    span.setAttribute('gen_ai.usage.output_tokens', 7);
    span.end();

    const [finished] = exporter.getFinishedSpans();
    assert.equal(finished.attributes['openinference.span.kind'], 'LLM');
    assert.equal(finished.attributes['input.value'], 'user: hello');
    assert.equal(finished.attributes['output.value'], 'assistant: hi');
    assert.equal(finished.attributes['llm.model_name'], 'openai/gpt-5.2-chat-latest');
    assert.equal(finished.attributes['llm.token_count.prompt'], 11);
    assert.equal(finished.attributes['llm.token_count.completion'], 7);
  });

  it('does not force model-carrying LiveKit spans to TraceRoot span kinds', () => {
    const tracer = provider.getTracer('livekit-agents');

    const userTurn = tracer.startSpan('user_turn');
    userTurn.setAttribute('gen_ai.request.model', 'deepgram/nova-3');
    userTurn.setAttribute('gen_ai.usage.input_tokens', 2);
    userTurn.setAttribute('lk.user_transcript', 'hello');
    userTurn.end();

    const llmNode = tracer.startSpan('llm_node');
    llmNode.setAttribute('gen_ai.request.model', 'openai/chat-latest');
    llmNode.setAttribute('gen_ai.usage.input_tokens', 12);
    llmNode.setAttribute('gen_ai.usage.output_tokens', 3);
    llmNode.setAttribute('lk.chat_ctx', 'user: add 12 and 30');
    llmNode.setAttribute('lk.response.text', 'tool call pending');
    llmNode.end();

    const spans = exporter.getFinishedSpans();
    assert.deepEqual(
      spans.map((span) => span.name),
      ['user_turn', 'llm_node'],
    );
    assert.deepEqual(
      spans.map((span) => span.attributes['openinference.span.kind']),
      [undefined, undefined],
    );
    assert.deepEqual(
      spans.map((span) => span.attributes['traceroot.span.type']),
      [undefined, undefined],
    );
  });

  it('does not modify non-LiveKit spans', () => {
    const tracer = provider.getTracer('openai');

    const span = tracer.startSpan('chat.completion');
    span.setAttribute('openinference.span.kind', 'LLM');
    span.setAttribute('input.value', 'existing input');
    span.setAttribute('gen_ai.request.model', 'gpt-4o');
    span.end();

    const [finished] = exporter.getFinishedSpans();
    assert.equal(finished.attributes['openinference.span.kind'], 'LLM');
    assert.equal(finished.attributes['input.value'], 'existing input');
    assert.equal(finished.attributes['llm.model_name'], undefined);
  });

  it('maps LiveKit attributes that are added with setAttributes() before end', () => {
    const tracer = provider.getTracer('livekit-agents');

    const span = tracer.startSpan('llm_request');
    span.setAttribute('lk.chat_ctx', 'user: hello');
    span.setAttribute('gen_ai.request.model', 'openai/gpt-5.2-chat-latest');
    span.setAttributes({
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 7,
      'lk.response.text': 'assistant: hi',
    });
    span.end();

    const [finished] = exporter.getFinishedSpans();
    assert.equal(finished.attributes['openinference.span.kind'], 'LLM');
    assert.equal(finished.attributes['input.value'], 'user: hello');
    assert.equal(finished.attributes['output.value'], 'assistant: hi');
    assert.equal(finished.attributes['llm.model_name'], 'openai/gpt-5.2-chat-latest');
    assert.equal(finished.attributes['llm.token_count.prompt'], 11);
    assert.equal(finished.attributes['llm.token_count.completion'], 7);
  });

  it('maps late LiveKit attributes at export time without mutating the live span', () => {
    const tracer = provider.getTracer('livekit-agents');

    const span = tracer.startSpan('agent_turn');
    span.setAttribute('lk.response.text', 'assistant: ready');

    assert.equal(
      (span as unknown as { attributes: Record<string, unknown> }).attributes['output.value'],
      undefined,
    );

    span.end();

    const [finished] = exporter.getFinishedSpans();
    assert.equal(finished.attributes['output.value'], 'assistant: ready');
  });

  it('maps LiveKit function_tool spans to tool kind, name, and IO', () => {
    const tracer = provider.getTracer('livekit-agents');

    const span = tracer.startSpan('function_tool');
    span.setAttribute('lk.function_tool.name', 'lookup_customer');
    span.setAttribute('lk.function_tool.arguments', '{"user_id":"user-123"}');
    span.setAttribute('lk.function_tool.output', '{"plan":"pro"}');
    span.end();

    const [finished] = exporter.getFinishedSpans();
    assert.equal(finished.attributes['openinference.span.kind'], 'TOOL');
    assert.equal(finished.attributes['gen_ai.tool.name'], 'lookup_customer');
    assert.equal(finished.attributes['input.value'], '{"user_id":"user-123"}');
    assert.equal(finished.attributes['output.value'], '{"plan":"pro"}');
  });
});

describe('LiveKit instrumentation wiring', () => {
  afterEach(async () => {
    await TraceRoot.shutdown();
    _resetForTesting();
  });

  it('passes TraceRoot provider to LiveKit telemetry', () => {
    const provider = new NodeTracerProvider();
    const calls: unknown[] = [];
    const livekitAgents = {
      telemetry: {
        setTracerProvider(tracerProvider: unknown) {
          calls.push(tracerProvider);
        },
      },
    };

    wireLiveKitInstrumentation(livekitAgents, provider);

    assert.deepEqual(calls, [provider]);
  });

  it('wires livekitAgents through the existing instrumentation entry point', () => {
    const provider = new NodeTracerProvider();
    const calls: unknown[] = [];
    const livekitAgents = {
      telemetry: {
        setTracerProvider(tracerProvider: unknown) {
          calls.push(tracerProvider);
        },
      },
    };

    wireInstrumentations({ livekitAgents }, provider);

    assert.deepEqual(calls, [provider]);
  });

  it('does not touch LiveKit when livekitAgents is not requested', () => {
    const provider = new NodeTracerProvider();

    assert.doesNotThrow(() => wireInstrumentations({}, provider));
  });

  it('passes the initialized TraceRoot provider to LiveKit', async () => {
    const calls: unknown[] = [];
    const livekitAgents = {
      telemetry: {
        setTracerProvider(tracerProvider: unknown) {
          calls.push(tracerProvider);
        },
      },
    };

    TraceRoot.initialize({
      apiKey: 'test-key',
      disableBatch: true,
      instrumentModules: { livekitAgents },
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof NodeTracerProvider);
  });
});
