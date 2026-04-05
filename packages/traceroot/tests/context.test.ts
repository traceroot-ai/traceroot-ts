import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { observe } from '../src/observe';
import { updateCurrentSpan, updateCurrentTrace, getCurrentTraceId, getCurrentSpanId } from '../src/context';
import { _resetForTesting } from '../src/traceroot';

describe('updateCurrentSpan()', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    _resetForTesting();
  });

  it('sets input.value on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentSpan({ input: { question: 'what?' } });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['input.value'], JSON.stringify({ question: 'what?' }));
  });

  it('sets output.value on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentSpan({ output: 'final answer' });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['output.value'], JSON.stringify('final answer'));
  });

  it('sets traceroot.span.metadata as JSON string on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentSpan({ metadata: { model: 'gpt-4o', temperature: 0.7 } });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(
      span.attributes['traceroot.span.metadata'],
      JSON.stringify({ model: 'gpt-4o', temperature: 0.7 }),
    );
  });

  it('is a no-op when called outside an active span', () => {
    assert.doesNotThrow(() => {
      updateCurrentSpan({ input: 'test' });
    });
  });

  // ── LLM-specific attributes ───────────────────────────────────────────────

  it('renames the span when name is provided', async () => {
    await observe({ name: 'original' }, async () => {
      updateCurrentSpan({ name: 'renamed-span' });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.name, 'renamed-span');
  });

  it('sets traceroot.llm.model on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentSpan({ model: 'gpt-4o' });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.llm.model'], 'gpt-4o');
  });

  it('sets traceroot.llm.model_parameters as JSON on the active span', async () => {
    const params = { temperature: 0.7, max_tokens: 1024 };
    await observe({ name: 'x' }, async () => {
      updateCurrentSpan({ modelParameters: params });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.llm.model_parameters'], JSON.stringify(params));
  });

  it('sets traceroot.llm.usage as JSON on the active span', async () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    await observe({ name: 'x' }, async () => {
      updateCurrentSpan({ usage });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.llm.usage'], JSON.stringify(usage));
  });

  it('sets traceroot.llm.prompt as JSON on the active span', async () => {
    const prompt = [{ role: 'user', content: 'hello' }];
    await observe({ name: 'x' }, async () => {
      updateCurrentSpan({ prompt });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.llm.prompt'], JSON.stringify(prompt));
  });
});

describe('updateCurrentTrace()', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    _resetForTesting();
  });

  it('sets session.id on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentTrace({ sessionId: 'sess-123' });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['session.id'], 'sess-123');
  });

  it('sets user.id on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentTrace({ userId: 'user-abc' });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['user.id'], 'user-abc');
  });

  it('sets traceroot.span.tags as JSON array on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentTrace({ tags: ['production', 'v2'] });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.span.tags'], JSON.stringify(['production', 'v2']));
  });

  it('is a no-op when called outside an active span', () => {
    assert.doesNotThrow(() => {
      updateCurrentTrace({ userId: 'u1' });
    });
  });

  it('sets traceroot.trace.metadata as JSON on the active span', async () => {
    const meta = { plan: 'pro', region: 'us-east-1' };
    await observe({ name: 'x' }, async () => {
      updateCurrentTrace({ metadata: meta });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.trace.metadata'], JSON.stringify(meta));
  });
});

describe('getCurrentTraceId() / getCurrentSpanId()', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    _resetForTesting();
  });

  it('returns undefined when called outside a span', () => {
    assert.equal(getCurrentTraceId(), undefined);
    assert.equal(getCurrentSpanId(), undefined);
  });

  it('returns a 32-hex-char string for trace ID inside an active span', async () => {
    let traceId: string | undefined;
    await observe({ name: 'x' }, async () => {
      traceId = getCurrentTraceId();
    });
    assert.ok(traceId !== undefined);
    assert.match(traceId, /^[0-9a-f]{32}$/);
  });

  it('returns a 16-hex-char string for span ID inside an active span', async () => {
    let spanId: string | undefined;
    await observe({ name: 'x' }, async () => {
      spanId = getCurrentSpanId();
    });
    assert.ok(spanId !== undefined);
    assert.match(spanId, /^[0-9a-f]{16}$/);
  });

  it('returns different trace IDs for spans in different traces', async () => {
    let traceId1: string | undefined;
    let traceId2: string | undefined;
    await observe({ name: 'trace-1' }, async () => {
      traceId1 = getCurrentTraceId();
    });
    await observe({ name: 'trace-2' }, async () => {
      traceId2 = getCurrentTraceId();
    });
    assert.ok(traceId1 !== undefined);
    assert.ok(traceId2 !== undefined);
    assert.notEqual(traceId1, traceId2);
  });

  it('child span has same trace ID as parent but different span ID', async () => {
    let parentTraceId: string | undefined;
    let parentSpanId: string | undefined;
    let childTraceId: string | undefined;
    let childSpanId: string | undefined;
    await observe({ name: 'parent' }, async () => {
      parentTraceId = getCurrentTraceId();
      parentSpanId = getCurrentSpanId();
      await observe({ name: 'child' }, async () => {
        childTraceId = getCurrentTraceId();
        childSpanId = getCurrentSpanId();
      });
    });
    assert.ok(parentTraceId !== undefined);
    assert.ok(parentSpanId !== undefined);
    assert.ok(childTraceId !== undefined);
    assert.ok(childSpanId !== undefined);
    assert.equal(childTraceId, parentTraceId);
    assert.notEqual(childSpanId, parentSpanId);
  });
});
