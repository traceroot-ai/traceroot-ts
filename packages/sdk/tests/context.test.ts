import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { observe } from '../src/observe';
import { updateCurrentSpan, updateCurrentTrace } from '../src/context';
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

  it('sets metadata as JSON string on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentSpan({ metadata: { model: 'gpt-4o', temperature: 0.7 } });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(
      span.attributes['metadata'],
      JSON.stringify({ model: 'gpt-4o', temperature: 0.7 }),
    );
  });

  it('is a no-op when called outside an active span', () => {
    assert.doesNotThrow(() => {
      updateCurrentSpan({ input: 'test' });
    });
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

  it('sets tag.tags as JSON array on the active span', async () => {
    await observe({ name: 'x' }, async () => {
      updateCurrentTrace({ tags: ['production', 'v2'] });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['tag.tags'], JSON.stringify(['production', 'v2']));
  });

  it('is a no-op when called outside an active span', () => {
    assert.doesNotThrow(() => {
      updateCurrentTrace({ userId: 'u1' });
    });
  });
});
