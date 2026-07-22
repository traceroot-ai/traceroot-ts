import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { context, propagation, trace } from '@opentelemetry/api';
import { applyUsage, applyModel } from '../src/attributes';
import { startSpan, usingSpan, _resetSpansState } from '../src/spans';
import { _resetForTesting, TraceRoot } from '../src/traceroot';
import { observe, _resetObserveState } from '../src/observe';
import { getCurrentSpan, updateCurrentSpan } from '../src/context';
import * as tr from '../src/index';
import { ContextIdGenerator } from '../src/trace-id';

describe('attribute mapping', () => {
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
    _resetObserveState();
  });

  it('applyUsage maps usage to OpenInference token keys, prompt is gross', () => {
    const span = trace.getTracer('t').startSpan('s');
    applyUsage(span, { input: 10, output: 5, cacheRead: 30, cacheWrite: 2 });
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['llm.token_count.prompt'], 42); // 10+30+2
    assert.equal(s.attributes['llm.token_count.completion'], 5);
    assert.equal(s.attributes['llm.token_count.total'], 47);
    assert.equal(s.attributes['llm.token_count.prompt_details.cache_read'], 30);
    assert.equal(s.attributes['llm.token_count.prompt_details.cache_write'], 2);
  });

  it('applyModel writes both llm.model_name and traceroot.llm.model', () => {
    const span = trace.getTracer('t').startSpan('s');
    applyModel(span, 'claude-sonnet-4-5', { temperature: 1 });
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['llm.model_name'], 'claude-sonnet-4-5');
    assert.equal(s.attributes['traceroot.llm.model'], 'claude-sonnet-4-5');
    assert.equal(
      s.attributes['traceroot.llm.model_parameters'],
      JSON.stringify({ temperature: 1 }),
    );
  });
});

describe('startSpan()', () => {
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
    _resetObserveState();
    _resetSpansState();
  });

  it('creates an llm span with name, kind, model, input; update sets usage+output; end closes it', () => {
    const span = startSpan({
      name: 'anthropic.messages.create',
      type: 'llm',
      input: [{ role: 'user' }],
      model: 'claude-sonnet-4-5',
    });
    span.update({ output: 'hi', usage: { input: 10, output: 5, cacheRead: 30, cacheWrite: 2 } });
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.name, 'anthropic.messages.create');
    assert.equal(s.attributes['openinference.span.kind'], 'LLM');
    assert.equal(s.attributes['llm.model_name'], 'claude-sonnet-4-5');
    assert.equal(s.attributes['input.value'], JSON.stringify([{ role: 'user' }]));
    assert.equal(s.attributes['output.value'], JSON.stringify('hi'));
    assert.equal(s.attributes['llm.token_count.prompt'], 42);
  });

  it('child via span.startSpan() is parented to the handle', () => {
    const parent = startSpan({ name: 'parent', type: 'agent' });
    const child = parent.startSpan({ name: 'child', type: 'tool' });
    child.end();
    parent.end();
    const spans = exporter.getFinishedSpans();
    const c = spans.find((x) => x.name === 'child')!;
    const p = spans.find((x) => x.name === 'parent')!;
    assert.equal(c.parentSpanId, p.spanContext().spanId);
  });

  it('setError marks the span status ERROR', () => {
    const span = startSpan({ name: 'boom' });
    span.setError(new Error('nope'));
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.status.code, 2 /* SpanStatusCode.ERROR */);
  });

  it('update({metadata}) does not throw on a circular object', () => {
    const span = startSpan({ name: 's', type: 'llm' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => span.update({ metadata: circular }));
    span.end();
  });
});

describe('usingSpan() nesting', () => {
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
    _resetObserveState();
    _resetSpansState();
  });

  it('observe() spans created inside usingSpan(parent) nest under the parent', async () => {
    const parent = startSpan({ name: 'llm-turn', type: 'llm' });
    await usingSpan(parent, () => observe({ name: 'GetWeather', type: 'tool' }, async () => 'ok'));
    parent.end();
    const spans = exporter.getFinishedSpans();
    const tool = spans.find((s) => s.name === 'GetWeather')!;
    assert.equal(tool.parentSpanId, parent.spanId);
    assert.equal(tool.attributes['openinference.span.kind'], 'TOOL');
  });
});

describe('getCurrentSpan() + updateCurrentSpan usage', () => {
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
    _resetObserveState();
    _resetSpansState();
  });

  it('getCurrentSpan() returns the active span as a handle', async () => {
    const parent = startSpan({ name: 'p', type: 'agent' });
    let seenId: string | undefined;
    await usingSpan(parent, async () => {
      seenId = getCurrentSpan()?.spanId;
    });
    parent.end();
    assert.equal(seenId, parent.spanId);
  });

  it('updateCurrentSpan({usage}) writes OpenInference token keys (bug fix)', async () => {
    await observe({ name: 'gen', type: 'llm' }, async () => {
      updateCurrentSpan({ usage: { input: 10, output: 5, cacheRead: 30, cacheWrite: 2 } });
    });
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['llm.token_count.prompt'], 42);
    assert.equal(s.attributes['llm.token_count.completion'], 5);
    assert.equal(s.attributes['llm.token_count.prompt_details.cache_read'], 30);
  });
});

describe('public exports', () => {
  it('exposes the imperative API', () => {
    assert.equal(typeof tr.startSpan, 'function');
    assert.equal(typeof tr.usingSpan, 'function');
    assert.equal(typeof tr.getCurrentSpan, 'function');
  });
});

describe('streaming turn (customer shape)', () => {
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
    _resetObserveState();
    _resetSpansState();
  });

  async function* fakeStream() {
    yield 'chunk-a';
    yield 'chunk-b';
  }

  it('llm span holds across a stream; tools nest under it; tokens set', async () => {
    const gen = startSpan({
      name: 'anthropic.messages.create',
      type: 'llm',
      input: [{ role: 'user' }],
    });
    const chunks: string[] = [];
    for await (const c of fakeStream()) chunks.push(c); // stream drains, handle still open
    gen.update({
      output: chunks.join(''),
      model: 'claude-sonnet-4-5',
      usage: { input: 10, output: 5, cacheRead: 30, cacheWrite: 2 },
    });
    await usingSpan(gen, async () => {
      await observe({ name: 'GetWeather', type: 'tool' }, async () => ({ city: 'Tokyo' }));
    });
    gen.end();

    const spans = exporter.getFinishedSpans();
    const llm = spans.find((s) => s.name === 'anthropic.messages.create')!;
    const tool = spans.find((s) => s.name === 'GetWeather')!;
    assert.equal(tool.parentSpanId, llm.spanContext().spanId); // NESTED
    assert.equal(llm.attributes['llm.token_count.prompt'], 42); // GROSS tokens
    assert.equal(llm.attributes['llm.token_count.prompt_details.cache_write'], 2);
    assert.equal(llm.attributes['output.value'], JSON.stringify('chunk-achunk-b'));
    assert.equal(llm.attributes['openinference.span.kind'], 'LLM');
    assert.equal(tool.attributes['openinference.span.kind'], 'TOOL');
  });
});

describe('attributes escape-hatch', () => {
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
    _resetObserveState();
    _resetSpansState();
  });

  it('startSpan({attributes}) sets arbitrary attributes verbatim', () => {
    startSpan({ name: 's', type: 'llm', attributes: { 'gen_ai.request.top_p': 0.9 } }).end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['gen_ai.request.top_p'], 0.9);
  });

  it('Span.update({attributes}) and updateCurrentSpan({attributes}) set arbitrary attributes', async () => {
    const span = startSpan({ name: 'a' });
    span.update({ attributes: { 'my.tag': 'x', 'my.n': 3 } });
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['my.tag'], 'x');
    assert.equal(s.attributes['my.n'], 3);
    exporter.reset();
    await observe({ name: 'b' }, async () => {
      updateCurrentSpan({ attributes: { 'domain.key': true } });
    });
    const [s2] = exporter.getFinishedSpans();
    assert.equal(s2.attributes['domain.key'], true);
  });
});

describe('fail-open when uninitialized (no provider)', () => {
  beforeEach(() => {
    // No provider registered → global API returns a no-op tracer.
    _resetForTesting();
    _resetObserveState();
    _resetSpansState();
  });
  afterEach(() => {
    _resetForTesting();
    _resetObserveState();
    _resetSpansState();
  });

  it('startSpan(...).update(...).setError(...).end() never throws and is a no-op', () => {
    assert.doesNotThrow(() => {
      const span = startSpan({ name: 'x', type: 'llm', input: { q: 1 } });
      span.update({ output: 'y', usage: { input: 5, output: 2 } });
      span.setError(new Error('boom'));
      const child = span.startSpan({ name: 'c', type: 'tool' });
      child.end();
      span.end();
    });
    assert.equal(typeof startSpan({ name: 'x' }).spanId, 'string');
  });

  it('usingSpan runs fn and returns its value with no provider', async () => {
    const span = startSpan({ name: 'p', type: 'agent' });
    const out = await usingSpan(span, async () => 42);
    span.end();
    assert.equal(out, 42);
  });
});

describe('branch coverage: getCurrentSpan + applyUsage edges', () => {
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
    _resetObserveState();
    _resetSpansState();
  });

  it('getCurrentSpan() returns undefined outside any active span', () => {
    assert.equal(getCurrentSpan(), undefined);
  });

  it('applyUsage honours an explicit total override', () => {
    const span = trace.getTracer('t').startSpan('s');
    applyUsage(span, { input: 5, output: 3, total: 999 });
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['llm.token_count.total'], 999);
  });

  it('applyUsage with cache-only sets a gross prompt and cache_read, no completion', () => {
    const span = trace.getTracer('t').startSpan('s');
    applyUsage(span, { cacheRead: 10 });
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['llm.token_count.prompt'], 10);
    assert.equal(s.attributes['llm.token_count.prompt_details.cache_read'], 10);
    assert.equal(s.attributes['llm.token_count.completion'], undefined);
  });
});

describe('startSpan() trace-id forcing', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  const FORCED = '11111111111111111111111111111111';

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    // The forcing generator must be on the GLOBALLY REGISTERED provider. The later
    // TraceRoot.initialize() calls only flip internal-mode state — their register()
    // is a silent no-op because this provider is already the global one.
    provider = new NodeTracerProvider({ idGenerator: new ContextIdGenerator() });
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    _resetForTesting();
    _resetSpansState();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('internal mode: forces the root id, children inherit, root exports with no parent', () => {
    TraceRoot.initialize({
      disableBatch: true,
      internalExport: { path: '/api/v1/internal/traces', projectId: 'p' },
    });
    const root = startSpan({ name: 'run', traceId: FORCED });
    assert.equal(root.traceId, FORCED);
    const child = root.startSpan({ name: 'judge' });
    assert.equal(child.traceId, FORCED);
    child.end();
    root.end();

    const exported = exporter.getFinishedSpans().find((s) => s.name === 'run');
    assert.ok(exported);
    assert.equal(exported.spanContext().traceId, FORCED);
    // Genuine root on the wire — the receiving route keys rootness on absent parent.
    assert.equal(exported.parentSpanId, undefined);
  });

  it('forces a fresh root even when called under an active span', () => {
    TraceRoot.initialize({
      disableBatch: true,
      internalExport: { path: '/api/v1/internal/traces', projectId: 'p' },
    });
    const ambient = startSpan({ name: 'ambient' });
    usingSpan(ambient, () => {
      const root = startSpan({ name: 'run', traceId: FORCED });
      assert.equal(root.traceId, FORCED);
      root.end();
    });
    ambient.end();
    const exported = exporter.getFinishedSpans().find((s) => s.name === 'run');
    assert.ok(exported);
    assert.equal(exported.parentSpanId, undefined);
    assert.notEqual(ambient.traceId, FORCED);
  });

  it('public mode: passing traceId warns and does NOT force', () => {
    const messages: string[] = [];
    const restore = console.warn;
    console.warn = (...a: unknown[]) => {
      messages.push(a.map(String).join(' '));
    };
    let root;
    try {
      TraceRoot.initialize({ apiKey: 'k', disableBatch: true });
      root = startSpan({ name: 'run', traceId: FORCED });
    } finally {
      console.warn = restore;
    }
    assert.notEqual(root.traceId, FORCED);
    assert.ok(messages.some((m) => m.includes('internal export mode')));
    root.end();
  });

  it('throws when traceId and parent are both provided', () => {
    TraceRoot.initialize({
      disableBatch: true,
      internalExport: { path: '/api/v1/internal/traces', projectId: 'p' },
    });
    const parent = startSpan({ name: 'parent' });
    assert.throws(() => startSpan({ name: 'child', traceId: FORCED, parent }), TypeError);
    parent.end();
  });

  it('child handles reject traceId at the type level (and at runtime)', () => {
    TraceRoot.initialize({
      disableBatch: true,
      internalExport: { path: '/api/v1/internal/traces', projectId: 'p' },
    });
    const parent = startSpan({ name: 'parent' });
    assert.throws(
      // @ts-expect-error traceId is excluded from child-handle startSpan options
      () => parent.startSpan({ name: 'child', traceId: FORCED }),
      TypeError,
    );
    parent.end();
  });

  it('throws on a malformed forced id', () => {
    TraceRoot.initialize({
      disableBatch: true,
      internalExport: { path: '/api/v1/internal/traces', projectId: 'p' },
    });
    assert.throws(() => startSpan({ name: 'run', traceId: 'bad' }), TypeError);
  });
});

describe('startSpan projectId validation', () => {
  it('projectId is mutually exclusive with parent', () => {
    const parent = startSpan({ name: 'p' });
    assert.throws(() => startSpan({ name: 'c', projectId: 'proj-1', parent }), TypeError);
    parent.end();
  });

  it('malformed projectId throws synchronously', () => {
    assert.throws(() => startSpan({ name: 'x', projectId: '' }), TypeError);
    assert.throws(() => startSpan({ name: 'x', projectId: 42 as unknown as string }), TypeError);
  });
});
