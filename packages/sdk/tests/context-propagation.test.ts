import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { observe } from '../src/observe';
import { _resetForTesting } from '../src/traceroot';

describe('async context propagation', () => {
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

  it('parallel observe() calls produce independent root spans (no cross-bleed)', async () => {
    await Promise.all([
      observe({ name: 'span-a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
      }),
      observe({ name: 'span-b' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
      }),
    ]);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);

    const a = spans.find((s) => s.name === 'span-a')!;
    const b = spans.find((s) => s.name === 'span-b')!;

    // Neither should have a parent
    assert.equal(a.parentSpanId, undefined);
    assert.equal(b.parentSpanId, undefined);
  });

  it('nested observe() inside parallel calls are children of their own parent only', async () => {
    await Promise.all([
      observe({ name: 'parent-a' }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        await observe({ name: 'child-a' }, async () => null);
      }),
      observe({ name: 'parent-b' }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        await observe({ name: 'child-b' }, async () => null);
      }),
    ]);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 4);

    const parentA = spans.find((s) => s.name === 'parent-a')!;
    const parentB = spans.find((s) => s.name === 'parent-b')!;
    const childA = spans.find((s) => s.name === 'child-a')!;
    const childB = spans.find((s) => s.name === 'child-b')!;

    assert.equal(childA.parentSpanId, parentA.spanContext().spanId);
    assert.equal(childB.parentSpanId, parentB.spanContext().spanId);
    // Cross-bleed check
    assert.notEqual(childA.parentSpanId, parentB.spanContext().spanId);
    assert.notEqual(childB.parentSpanId, parentA.spanContext().spanId);
  });
});
