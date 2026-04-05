import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { observe } from '../src/observe';
import { _resetForTesting } from '../src/traceroot';

// Attribute keys
const SPAN_KIND_ATTR = 'openinference.span.kind';
const INPUT_VALUE_ATTR = 'input.value';
const OUTPUT_VALUE_ATTR = 'output.value';
const METADATA_ATTR = 'traceroot.span.metadata';
const TAG_TAGS_ATTR = 'traceroot.span.tags';
const GIT_SOURCE_FILE_ATTR = 'traceroot.git.source_file';
const GIT_SOURCE_LINE_ATTR = 'traceroot.git.source_line';

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
    async function myFunction() {
      return 42;
    }
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

  it('records input.value when args are provided', async () => {
    const fn = async (_query: string) => null;
    await observe({ name: 'x' }, fn, 'hello');
    const [span] = exporter.getFinishedSpans();
    // Single arg captured directly (not wrapped in array)
    assert.equal(span.attributes[INPUT_VALUE_ATTR], JSON.stringify('hello'));
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
      () =>
        observe({ name: 'x' }, async () => {
          throw err;
        }),
      { message: 'boom' },
    );
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.ok(span.events.some((e) => e.name === 'exception'));
  });

  it('ends the span even when fn() throws', async () => {
    await assert.rejects(() =>
      observe({ name: 'x' }, async () => {
        throw new Error('fail');
      }),
    );
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

  it('records metadata attribute when metadata is provided', async () => {
    await observe({ name: 'x', metadata: { key: 'val' } }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[METADATA_ATTR], JSON.stringify({ key: 'val' }));
  });

  it('does not set metadata attribute when metadata is not provided', async () => {
    await observe({ name: 'x' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[METADATA_ATTR], undefined);
  });

  it('records tag.tags attribute when tags are provided', async () => {
    await observe({ name: 'x', tags: ['a', 'b'] }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[TAG_TAGS_ATTR], JSON.stringify(['a', 'b']));
  });

  it('does not set tag.tags when tags not provided', async () => {
    await observe({ name: 'x' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[TAG_TAGS_ATTR], undefined);
  });

  it('stamps traceroot.git.source_file on the span', async () => {
    await observe({ name: 'x' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(typeof span.attributes[GIT_SOURCE_FILE_ATTR], 'string');
  });

  it('stamps traceroot.git.source_line as a number on the span', async () => {
    await observe({ name: 'x' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(typeof span.attributes[GIT_SOURCE_LINE_ATTR], 'number');
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

  // ── New API: observe(options, fn, ...args) ────────────────────────────────

  it('auto-captures multiple args as input.value JSON array', async () => {
    const fn = async (x: string, y: number) => `${x}-${y}`;
    const result = await observe({ name: 'x' }, fn, 'hello', 42);
    assert.equal(result, 'hello-42');
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[INPUT_VALUE_ATTR], JSON.stringify(['hello', 42]));
  });

  it('auto-captures a single arg as input.value directly (not wrapped in array)', async () => {
    const fn = async (msg: string) => msg.toUpperCase();
    const result = await observe({ name: 'x' }, fn, 'hello');
    assert.equal(result, 'HELLO');
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[INPUT_VALUE_ATTR], JSON.stringify('hello'));
  });

  it('does not set input.value when zero args are passed (thunk backward compat)', async () => {
    await observe({ name: 'x' }, async () => 'result');
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[INPUT_VALUE_ATTR], undefined);
  });

  it('does not set input.value when captureInput is false', async () => {
    const fn = async (x: string) => x;
    await observe({ name: 'x', captureInput: false }, fn, 'secret');
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[INPUT_VALUE_ATTR], undefined);
  });

  it('does not set output.value when captureOutput is false', async () => {
    const fn = async () => ({ sensitive: true });
    await observe({ name: 'x', captureOutput: false }, fn);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes[OUTPUT_VALUE_ATTR], undefined);
  });

  it('sets session.id when sessionId is provided in options', async () => {
    await observe({ name: 'x', sessionId: 'sess-abc' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['session.id'], 'sess-abc');
  });

  it('sets user.id when userId is provided in options', async () => {
    await observe({ name: 'x', userId: 'user-xyz' }, async () => null);
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['user.id'], 'user-xyz');
  });

  it('wraps async generator — yields all chunks back and records them as output', async () => {
    async function* stream(prefix: string) {
      yield `${prefix}-1`;
      yield `${prefix}-2`;
      yield `${prefix}-3`;
    }

    const gen = observe({ name: 'stream-span' }, stream, 'chunk') as AsyncIterable<string>;

    const chunks: string[] = [];
    for await (const item of gen) {
      chunks.push(item);
    }

    assert.deepStrictEqual(chunks, ['chunk-1', 'chunk-2', 'chunk-3']);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'stream-span');
    assert.equal(
      spans[0].attributes[OUTPUT_VALUE_ATTR],
      JSON.stringify(['chunk-1', 'chunk-2', 'chunk-3']),
    );
  });

  it('auto-initializes when TRACEROOT_API_KEY is set and SDK is not yet initialized', async () => {
    // Remove the provider so the SDK is "not initialized"
    await provider.shutdown();
    exporter.reset();
    _resetForTesting();

    const prev = process.env['TRACEROOT_API_KEY'];
    process.env['TRACEROOT_API_KEY'] = 'test-key-auto-init';
    try {
      // Should auto-initialize and not warn, and the fn result should be returned
      const result = await observe({ name: 'x' }, async () => 'auto-init-result');
      assert.equal(result, 'auto-init-result');
      // SDK should now be initialized
      const { TraceRoot } = await import('../src/traceroot');
      assert.equal(TraceRoot.isInitialized(), true);
    } finally {
      process.env['TRACEROOT_API_KEY'] = prev;
      _resetForTesting();
    }
  });
});
