import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { observe } from '../src/observe';
import { _resetForTesting } from '../src/traceroot';

// OpenInference attribute keys
const SPAN_KIND_ATTR = 'openinference.span.kind';
const INPUT_VALUE_ATTR = 'input.value';
const OUTPUT_VALUE_ATTR = 'output.value';

describe('observe()', () => {
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
    _resetForTesting(); // clear the "warned uninit" flag and deregister OTel globals
  });

  it('creates a span with the given name', async () => {
    await observe({ name: 'my-span' }, async () => 'result');
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.name, 'my-span');
  });

  it('falls back to fn.name when name is omitted', async () => {
    async function myFunction() { return 42; }
    await observe({}, myFunction);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.name, 'myFunction');
  });

  it('falls back to "anonymous" for arrow functions without name', async () => {
    await observe({}, async () => 1);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.name, 'anonymous');
  });

  it('sets openinference.span.kind = CHAIN for default type', async () => {
    await observe({ name: 'x' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[SPAN_KIND_ATTR], 'CHAIN');
  });

  it('sets openinference.span.kind = AGENT for type agent', async () => {
    await observe({ name: 'x', type: 'agent' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[SPAN_KIND_ATTR], 'AGENT');
  });

  it('sets openinference.span.kind = TOOL for type tool', async () => {
    await observe({ name: 'x', type: 'tool' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[SPAN_KIND_ATTR], 'TOOL');
  });

  it('sets openinference.span.kind = LLM for type llm', async () => {
    await observe({ name: 'x', type: 'llm' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[SPAN_KIND_ATTR], 'LLM');
  });

  it('records input.value when input is provided', async () => {
    await observe({ name: 'x', input: { query: 'hello' } }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[INPUT_VALUE_ATTR], JSON.stringify({ query: 'hello' }));
  });

  it('does not set input.value when input is not provided', async () => {
    await observe({ name: 'x' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[INPUT_VALUE_ATTR], undefined);
  });

  it('records output.value as JSON of the return value', async () => {
    await observe({ name: 'x' }, async () => ({ answer: 42 }));
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[OUTPUT_VALUE_ATTR], JSON.stringify({ answer: 42 }));
  });

  it('returns the value from fn()', async () => {
    const result = await observe({ name: 'x' }, async () => 'hello');
    assert.equal(result, 'hello');
  });

  it('records exception and sets ERROR status on throw, then re-throws', async () => {
    const err = new Error('boom');
    await assert.rejects(
      () => observe({ name: 'x' }, async () => { throw err; }),
      { message: 'boom' },
    );
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.ok(span.events.some((e) => e.name === 'exception'));
  });

  it('ends the span even when fn() throws', async () => {
    await assert.rejects(() => observe({ name: 'x' }, async () => { throw new Error('fail'); }));
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.ok(spans[0].endTime[0] > 0); // endTime is set
  });

  it('creates parent-child spans for nested observe() calls', async () => {
    await observe({ name: 'parent' }, async () => {
      await observe({ name: 'child' }, async () => null);
    });
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    const parent = spans.find((s) => s.name === 'parent')!;
    const child = spans.find((s) => s.name === 'child')!;
    assert.equal(child.parentSpanId, parent.spanContext().spanId);
  });

  it('runs fn() as a no-op and returns result when not initialized', async () => {
    // No provider registered and no TraceRoot.initialize() called —
    // observe() must still call fn() and return its value.
    await provider.shutdown(); // remove the registered provider
    exporter.reset();
    _resetForTesting(); // deregister OTel globals

    const result = await observe({ name: 'x' }, async () => 'untraced');
    assert.equal(result, 'untraced');
    // No spans recorded
    assert.equal(exporter.getFinishedSpans().length, 0);
  });
});
