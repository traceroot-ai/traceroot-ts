import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  getSpanName,
  getSpanAttributes,
  TraceRootTracingProcessor,
  wireOpenAIAgentsProcessor,
} from '../src/openai-agents';
import type { OASpanData } from '../src/openai-agents';

describe('getSpanName()', () => {
  it('agent → agent name', () => {
    assert.equal(
      getSpanName({ type: 'agent', name: 'SupportAgent', tools: [], handoffs: [] }),
      'SupportAgent',
    );
  });
  it('function → function name', () => {
    assert.equal(
      getSpanName({ type: 'function', name: 'search', input: '', output: '' }),
      'search',
    );
  });
  it('generation with model', () => {
    assert.equal(getSpanName({ type: 'generation', model: 'gpt-4o' }), 'generation [gpt-4o]');
  });
  it('generation without model', () => {
    assert.equal(getSpanName({ type: 'generation' }), 'generation');
  });
  it('response', () => {
    assert.equal(getSpanName({ type: 'response' }), 'response');
  });
  it('handoff with to_agent', () => {
    assert.equal(
      getSpanName({ type: 'handoff', to_agent: 'BillingAgent' }),
      'handoff -> BillingAgent',
    );
  });
  it('handoff without to_agent', () => {
    assert.equal(getSpanName({ type: 'handoff' }), 'handoff');
  });
  it('custom → custom name', () => {
    assert.equal(getSpanName({ type: 'custom', name: 'my-step', data: {} }), 'my-step');
  });
  it('guardrail → guardrail name', () => {
    assert.equal(
      getSpanName({ type: 'guardrail', name: 'safety-check', triggered: false }),
      'safety-check',
    );
  });
  it('mcp_tools with server', () => {
    assert.equal(getSpanName({ type: 'mcp_tools', server: 'files' }), 'mcp_tools [files]');
  });
  it('mcp_tools without server', () => {
    assert.equal(getSpanName({ type: 'mcp_tools' }), 'mcp_tools');
  });
});

describe('getSpanAttributes()', () => {
  it('all types set openinference.span.kind', () => {
    const cases: Array<[OASpanData, string]> = [
      [{ type: 'agent', name: 'x', tools: [], handoffs: [] }, 'AGENT'],
      [{ type: 'function', name: 'x', input: '', output: '' }, 'TOOL'],
      [{ type: 'generation' }, 'LLM'],
      [{ type: 'response' }, 'LLM'],
      [{ type: 'handoff' }, 'AGENT'],
      [{ type: 'custom', name: 'x', data: {} }, 'CHAIN'],
      [{ type: 'guardrail', name: 'x', triggered: false }, 'CHAIN'],
      [{ type: 'transcription' }, 'LLM'],
      [{ type: 'speech' }, 'LLM'],
      [{ type: 'speech_group' }, 'CHAIN'],
      [{ type: 'mcp_tools' }, 'TOOL'],
    ];
    for (const [data, kind] of cases) {
      assert.equal(
        getSpanAttributes(data)['openinference.span.kind'],
        kind,
        `wrong kind for ${data.type}`,
      );
    }
  });

  it('function: sets tool.name, input.value, output.value', () => {
    const attrs = getSpanAttributes({
      type: 'function',
      name: 'search',
      input: '{"q":"hi"}',
      output: '{"r":1}',
    });
    assert.equal(attrs['tool.name'], 'search');
    assert.equal(attrs['input.value'], '{"q":"hi"}');
    assert.equal(attrs['output.value'], '{"r":1}');
  });

  it('generation: sets llm.model_name and token counts', () => {
    const attrs = getSpanAttributes({
      type: 'generation',
      model: 'gpt-4o',
      input: [{ role: 'user', content: 'hi' }],
      output: [{ role: 'assistant', content: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    assert.equal(attrs['llm.model_name'], 'gpt-4o');
    assert.equal(attrs['llm.token_count.prompt'], 10);
    assert.equal(attrs['llm.token_count.completion'], 20);
    assert.ok(attrs['input.value']);
    assert.ok(attrs['output.value']);
  });

  it('generation: omits token counts when usage absent', () => {
    const attrs = getSpanAttributes({ type: 'generation' });
    assert.equal(attrs['llm.token_count.prompt'], undefined);
    assert.equal(attrs['llm.token_count.completion'], undefined);
  });

  it('agent: sets agent.name', () => {
    const attrs = getSpanAttributes({
      type: 'agent',
      name: 'SupportAgent',
      tools: ['search'],
      handoffs: [],
    });
    assert.equal(attrs['agent.name'], 'SupportAgent');
  });

  it('handoff: sets agent.name and metadata with to_agent', () => {
    const attrs = getSpanAttributes({ type: 'handoff', from_agent: 'A', to_agent: 'B' });
    assert.equal(attrs['agent.name'], 'A');
    assert.deepEqual(JSON.parse(attrs['traceroot.span.metadata'] as string), { to_agent: 'B' });
  });

  it('guardrail: sets metadata with triggered', () => {
    const attrs = getSpanAttributes({ type: 'guardrail', name: 'safety', triggered: true });
    assert.deepEqual(JSON.parse(attrs['traceroot.span.metadata'] as string), { triggered: true });
  });

  it('mcp_tools: sets tool.name and output.value', () => {
    const attrs = getSpanAttributes({
      type: 'mcp_tools',
      server: 'files',
      result: ['read', 'write'],
    });
    assert.equal(attrs['tool.name'], 'files');
    assert.deepEqual(JSON.parse(attrs['output.value'] as string), ['read', 'write']);
  });

  it('response: extracts model and tokens from _response', () => {
    const attrs = getSpanAttributes({
      type: 'response',
      _response: { model: 'gpt-4o', usage: { input_tokens: 5, output_tokens: 15 } },
    });
    assert.equal(attrs['llm.model_name'], 'gpt-4o');
    assert.equal(attrs['llm.token_count.prompt'], 5);
    assert.equal(attrs['llm.token_count.completion'], 15);
  });

  it('response: sets output.value from _response.output', () => {
    const attrs = getSpanAttributes({
      type: 'response',
      _response: { output: [{ role: 'assistant', content: 'hi' }] },
    });
    assert.ok(attrs['output.value']);
    assert.deepEqual(JSON.parse(attrs['output.value'] as string), [
      { role: 'assistant', content: 'hi' },
    ]);
  });
});

describe('TraceRootTracingProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let processor: TraceRootTracingProcessor;

  const mockTrace = { type: 'trace' as const, traceId: 'trace_abc', name: 'Test Workflow' };

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
    processor = new TraceRootTracingProcessor();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('onTraceStart/End creates a root CHAIN span with the trace name', async () => {
    await processor.onTraceStart(mockTrace);
    await processor.onTraceEnd(mockTrace);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'Test Workflow');
    assert.equal(spans[0].attributes['openinference.span.kind'], 'CHAIN');
  });

  it('onSpanEnd creates a span with attributes set', async () => {
    const s = {
      type: 'trace.span' as const,
      spanId: 'span_001',
      traceId: 'trace_abc',
      parentId: null,
      spanData: {
        type: 'function' as const,
        name: 'search',
        input: '{"q":"hello"}',
        output: '{"r":1}',
      },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: null,
    };

    await processor.onTraceStart(mockTrace);
    await processor.onSpanStart(s);
    await processor.onSpanEnd(s);
    await processor.onTraceEnd(mockTrace);

    const spans = exporter.getFinishedSpans();
    const toolSpan = spans.find((s) => s.name === 'search')!;
    assert.ok(toolSpan, 'tool span not found');
    assert.equal(toolSpan.attributes['tool.name'], 'search');
    assert.equal(toolSpan.attributes['input.value'], '{"q":"hello"}');
    assert.equal(toolSpan.attributes['output.value'], '{"r":1}');
  });

  it('child span parentId is resolved to the correct parent OTel span (3 levels)', async () => {
    const agentSpan = {
      type: 'trace.span' as const,
      spanId: 'span_agent',
      traceId: 'trace_abc',
      parentId: null,
      spanData: { type: 'agent' as const, name: 'SupportAgent', tools: [], handoffs: [] },
      startedAt: new Date().toISOString(),
      endedAt: null as string | null,
      error: null,
    };
    const toolSpan = {
      type: 'trace.span' as const,
      spanId: 'span_tool',
      traceId: 'trace_abc',
      parentId: 'span_agent',
      spanData: { type: 'function' as const, name: 'search', input: '{}', output: '{}' },
      startedAt: new Date().toISOString(),
      endedAt: null as string | null,
      error: null,
    };
    const genSpan = {
      type: 'trace.span' as const,
      spanId: 'span_gen',
      traceId: 'trace_abc',
      parentId: 'span_tool',
      spanData: { type: 'generation' as const, model: 'gpt-4o' },
      startedAt: new Date().toISOString(),
      endedAt: null as string | null,
      error: null,
    };

    await processor.onTraceStart(mockTrace);
    await processor.onSpanStart(agentSpan);
    await processor.onSpanStart(toolSpan);
    await processor.onSpanStart(genSpan);
    await processor.onSpanEnd({ ...genSpan, endedAt: new Date().toISOString() });
    await processor.onSpanEnd({ ...toolSpan, endedAt: new Date().toISOString() });
    await processor.onSpanEnd({ ...agentSpan, endedAt: new Date().toISOString() });
    await processor.onTraceEnd(mockTrace);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 4); // root + agent + tool + generation

    const root = spans.find((s) => s.name === 'Test Workflow')!;
    const agent = spans.find((s) => s.name === 'SupportAgent')!;
    const tool = spans.find((s) => s.name === 'search')!;
    const gen = spans.find((s) => s.name === 'generation [gpt-4o]')!;

    assert.ok(root, 'root span missing');
    assert.ok(agent, 'agent span missing');
    assert.ok(tool, 'tool span missing');
    assert.ok(gen, 'generation span missing');

    // True 3-level nesting: gen → tool → agent → root
    assert.equal(gen.parentSpanId, tool.spanContext().spanId);
    assert.equal(tool.parentSpanId, agent.spanContext().spanId);
    assert.equal(agent.parentSpanId, root.spanContext().spanId);
  });

  it('span with no parentId is parented to the trace root', async () => {
    const s = {
      type: 'trace.span' as const,
      spanId: 'span_orphan',
      traceId: 'trace_abc',
      parentId: null,
      spanData: { type: 'custom' as const, name: 'step', data: {} },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: null,
    };

    await processor.onTraceStart(mockTrace);
    await processor.onSpanStart(s);
    await processor.onSpanEnd(s);
    await processor.onTraceEnd(mockTrace);

    const root = exporter.getFinishedSpans().find((sp) => sp.name === 'Test Workflow')!;
    const step = exporter.getFinishedSpans().find((sp) => sp.name === 'step')!;
    assert.ok(root, 'root missing');
    assert.ok(step, 'step missing');
    assert.equal(step.parentSpanId, root.spanContext().spanId);
  });

  it('sets SpanStatusCode.ERROR when span has an error', async () => {
    const s = {
      type: 'trace.span' as const,
      spanId: 'span_err',
      traceId: 'trace_abc',
      parentId: null,
      spanData: { type: 'function' as const, name: 'fail', input: '', output: '' },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: { message: 'tool exploded' },
    };

    await processor.onTraceStart(mockTrace);
    await processor.onSpanStart(s);
    await processor.onSpanEnd(s);
    await processor.onTraceEnd(mockTrace);

    const errSpan = exporter.getFinishedSpans().find((sp) => sp.name === 'fail')!;
    assert.ok(errSpan, 'error span missing');
    assert.equal(errSpan.status.code, 2 /* SpanStatusCode.ERROR */);
    assert.equal(errSpan.status.message, 'tool exploded');
  });

  it('cleans up internal maps after onSpanEnd and onTraceEnd', async () => {
    const s = {
      type: 'trace.span' as const,
      spanId: 'span_cleanup',
      traceId: 'trace_abc',
      parentId: null,
      spanData: { type: 'custom' as const, name: 'x', data: {} },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: null,
    };

    await processor.onTraceStart(mockTrace);
    await processor.onSpanStart(s);
    // spanMap holds both the trace-root entry (keyed by traceId) and child span entries
    // (keyed by spanId) in the same map — so after onTraceStart + onSpanStart: size = 2
    assert.equal((processor as any).spanMap.size, 2);
    await processor.onSpanEnd(s);
    assert.equal((processor as any).spanMap.size, 1); // only trace root
    await processor.onTraceEnd(mockTrace);
    assert.equal((processor as any).spanMap.size, 0);
  });
});

describe('wireOpenAIAgentsProcessor()', () => {
  it('calls registerProcessor on the module provider with a TraceRootTracingProcessor', () => {
    let registered: unknown;
    const mockModule = {
      getGlobalTraceProvider: () => ({
        registerProcessor: (p: unknown) => {
          registered = p;
        },
      }),
    };

    wireOpenAIAgentsProcessor(mockModule);
    assert.ok(registered instanceof TraceRootTracingProcessor);
  });

  it('throws if module does not expose getGlobalTraceProvider', () => {
    assert.throws(() => wireOpenAIAgentsProcessor({}), /getGlobalTraceProvider/);
  });

  it('throws if provider.registerProcessor is not a function', () => {
    assert.throws(
      () =>
        wireOpenAIAgentsProcessor({
          getGlobalTraceProvider: () => ({ registerProcessor: 'not-a-function' }),
        }),
      /registerProcessor/,
    );
  });
});
