// Acceptance tests for multi-project attribution: a per-root project id carried in
// OTel context and stamped on EVERY span in the root's tree by the span processor —
// including spans created by third-party auto-instrumentation that never sees this
// SDK's API — with no cross-stamping between concurrent roots.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { _resetForTesting } from '../src/traceroot';
import { TraceRootSpanProcessor } from '../src/processor';
import { ContextIdGenerator, _setInternalMode } from '../src/trace-id';
import { contextWithProjectId, PROJECT_ID_ATTR } from '../src/project-id';
import { _resetSpansState, startSpan } from '../src/spans';
import { observe } from '../src/observe';

const RUN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * Register an in-memory pipeline mirroring initialize()'s stack, without any real
 * initialize() call: internal mode is flipped directly. No OTLP export happens.
 */
function registerHarness(opts: { dropSpansWithoutProjectId?: boolean } = {}): {
  exporter: InMemorySpanExporter;
  provider: NodeTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ idGenerator: new ContextIdGenerator() });
  provider.addSpanProcessor(
    new TraceRootSpanProcessor(new SimpleSpanProcessor(exporter), {
      environment: 'prod',
      globalAttributes: { 'traceroot.source': 'detector' },
      ...opts,
    }),
  );
  provider.register();
  _setInternalMode(true);
  return { exporter, provider };
}

async function teardownHarness(provider: NodeTracerProvider): Promise<void> {
  await provider.shutdown();
  _resetForTesting();
  _resetSpansState();
  trace.disable();
  context.disable();
  propagation.disable();
}

describe('processor stamping from context', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness());
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('stamps the attribute on a span started under a context carrying the id', () => {
    const tracer = trace.getTracer('t');
    const span = tracer.startSpan('root', undefined, contextWithProjectId(ROOT_CONTEXT, 'proj-1'));
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes[PROJECT_ID_ATTR], 'proj-1');
  });

  it('leaves the attribute off when no context value exists', () => {
    const tracer = trace.getTracer('t');
    const span = tracer.startSpan('bare');
    span.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes[PROJECT_ID_ATTR], undefined);
  });

  it('falls back to the in-process parent map for explicit-parent children', () => {
    const tracer = trace.getTracer('t');
    // Root carries the id via context; the child is started against a context that
    // has the parent SPAN but not the value — the map must cover it.
    const root = tracer.startSpan('root', undefined, contextWithProjectId(ROOT_CONTEXT, 'proj-1'));
    const child = tracer.startSpan('child', undefined, trace.setSpan(ROOT_CONTEXT, root));
    child.end();
    root.end();
    const childSpan = exporter.getFinishedSpans().find((s) => s.name === 'child');
    assert.ok(childSpan);
    assert.equal(childSpan.attributes[PROJECT_ID_ATTR], 'proj-1');
  });

  it('context value wins over the parent map when both are present', () => {
    const tracer = trace.getTracer('t');
    const root = tracer.startSpan('root', undefined, contextWithProjectId(ROOT_CONTEXT, 'proj-map'));
    // Child context carries the parent span (map says proj-map) AND an explicit
    // conflicting value — the context value must win.
    const child = tracer.startSpan(
      'child',
      undefined,
      contextWithProjectId(trace.setSpan(ROOT_CONTEXT, root), 'proj-ctx'),
    );
    child.end();
    root.end();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.find((s) => s.name === 'root')?.attributes[PROJECT_ID_ATTR], 'proj-map');
    assert.equal(spans.find((s) => s.name === 'child')?.attributes[PROJECT_ID_ATTR], 'proj-ctx');
  });
});

describe('observe() multi-project attribution', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness());
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('stamps every span in the tree, including plain-OTel spans in the active context', async () => {
    await observe({ name: 'detector-run', traceId: RUN_A, projectId: 'proj-1' }, async () => {
      // Auto-instrumentation stand-in: a third-party tracer that never sees our API.
      const plain = trace.getTracer('third-party').startSpan('auto-instr');
      plain.end();
      return observe({ name: 'judge-llm', type: 'llm' }, async () => 'verdict');
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 3);
    for (const s of spans) {
      assert.equal(s.attributes[PROJECT_ID_ATTR], 'proj-1', `span ${s.name} unattributed`);
      assert.equal(s.spanContext().traceId, RUN_A);
    }
  });

  it('two concurrent roots with different projectIds never cross-stamp', async () => {
    const run = (runId: string, projectId: string) =>
      observe({ name: 'detector-run', traceId: runId, projectId }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return observe({ name: 'child' }, async () => 'x');
      });
    await Promise.all([run(RUN_A, 'proj-a'), run(RUN_B, 'proj-b')]);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 4);
    for (const [runId, projectId] of [
      [RUN_A, 'proj-a'],
      [RUN_B, 'proj-b'],
    ] as const) {
      const group = spans.filter((s) => s.spanContext().traceId === runId);
      assert.equal(group.length, 2);
      for (const s of group) assert.equal(s.attributes[PROJECT_ID_ATTR], projectId);
    }
  });

  it('projectId works without a forced traceId', async () => {
    await observe({ name: 'run', projectId: 'proj-1' }, async () => 'ok');
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes[PROJECT_ID_ATTR], 'proj-1');
  });

  it('generator roots attribute their children too', async () => {
    const gen = observe({ name: 'stream', traceId: RUN_A, projectId: 'proj-1' }, async function* () {
      yield await observe({ name: 'step' }, async () => 1);
    });
    for await (const _ of gen) {
      void _;
    }
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    for (const s of spans) assert.equal(s.attributes[PROJECT_ID_ATTR], 'proj-1');
  });
});

describe('observe() projectId gating and validation', () => {
  it('public mode: warns once, exports the span without the attribute', async () => {
    // Harness WITHOUT internal mode: register the pipeline, never flip the flag.
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ idGenerator: new ContextIdGenerator() });
    provider.addSpanProcessor(
      new TraceRootSpanProcessor(new SimpleSpanProcessor(exporter), {}),
    );
    provider.register();
    const { mock } = await import('node:test');
    const warn = mock.method(console, 'warn', () => {});
    try {
      await observe({ name: 'run', projectId: 'proj-1' }, async () => 'ok');
      await observe({ name: 'run2', projectId: 'proj-1' }, async () => 'ok');
      const spans = exporter.getFinishedSpans();
      assert.equal(spans.length, 2);
      for (const s of spans) assert.equal(s.attributes[PROJECT_ID_ATTR], undefined);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      warn.mock.restore();
      await teardownHarness(provider);
    }
  });

  it('malformed projectId throws synchronously, generator or not', () => {
    assert.throws(() => observe({ name: 'x', projectId: '' }, async () => 1), TypeError);
    assert.throws(
      () => observe({ name: 'x', projectId: 123 as unknown as string }, async () => 1),
      TypeError,
    );
    // Generator body must not need to run for validation to fire.
    assert.throws(
      () =>
        observe({ name: 'x', projectId: '' }, async function* () {
          yield 1;
        }),
      TypeError,
    );
  });
});

describe('startSpan() multi-project attribution (adapter shape)', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness());
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('root with forced id + projectId, child handle inherits the attribution', () => {
    const root = startSpan({ name: 'run', traceId: RUN_A, projectId: 'proj-1' });
    const child = root.startSpan({ name: 'judge' });
    child.end();
    root.end();

    const spans = exporter.getFinishedSpans();
    const rootSpan = spans.find((s) => s.name === 'run');
    const childSpan = spans.find((s) => s.name === 'judge');
    assert.ok(rootSpan && childSpan);
    assert.equal(rootSpan.attributes[PROJECT_ID_ATTR], 'proj-1');
    assert.equal(childSpan.attributes[PROJECT_ID_ATTR], 'proj-1');
    assert.equal(rootSpan.spanContext().traceId, RUN_A);
    assert.equal(rootSpan.parentSpanId, undefined);
  });

  it('child started from a root handle AFTER the root has ended still inherits the project', () => {
    const root = startSpan({ name: 'run', traceId: RUN_A, projectId: 'proj-1' });
    root.end();
    // The map entry for root's spanId was deleted in onEnd — attribution must fall
    // back to the project id already stamped on the (now-ended) root span object.
    const lateChild = root.startSpan({ name: 'late-child' });
    lateChild.end();

    const spans = exporter.getFinishedSpans();
    const lateChildSpan = spans.find((s) => s.name === 'late-child');
    assert.ok(lateChildSpan);
    assert.equal(lateChildSpan.attributes[PROJECT_ID_ATTR], 'proj-1');
  });

  it('explicit-parent child keeps its own project even inside another project scope', async () => {
    const rootB = startSpan({ name: 'root-b', traceId: RUN_B, projectId: 'proj-b' });
    await observe({ name: 'root-a', traceId: RUN_A, projectId: 'proj-a' }, async () => {
      // A handle from another root, used while proj-a's scope is ambiently active:
      // the child must stay proj-b — never inherit the ambient proj-a.
      const child = rootB.startSpan({ name: 'child-b' });
      child.end();
    });
    rootB.end();

    const spans = exporter.getFinishedSpans();
    const childB = spans.find((s) => s.name === 'child-b');
    const rootA = spans.find((s) => s.name === 'root-a');
    assert.ok(childB && rootA);
    assert.equal(childB.attributes[PROJECT_ID_ATTR], 'proj-b');
    assert.equal(childB.spanContext().traceId, RUN_B);
    assert.equal(rootA.attributes[PROJECT_ID_ATTR], 'proj-a');
  });
});

describe('drop-guard for unattributed spans (internal mode, no default project)', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness({ dropSpansWithoutProjectId: true }));
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('drops a stray span, keeps attributed spans, warns once', async () => {
    const { mock } = await import('node:test');
    const warn = mock.method(console, 'warn', () => {});
    try {
      await observe({ name: 'run', traceId: RUN_A, projectId: 'proj-1' }, async () => 'ok');
      // Stray background span outside any project scope — must go nowhere.
      const stray = trace.getTracer('bg').startSpan('stray');
      stray.end();
      const stray2 = trace.getTracer('bg').startSpan('stray-2');
      stray2.end();

      const names = exporter.getFinishedSpans().map((s) => s.name);
      assert.deepEqual(names, ['run']);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      warn.mock.restore();
    }
  });
});

describe('no drop-guard when a process default exists', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness({ dropSpansWithoutProjectId: false }));
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('exports unattributed spans (the header fallback covers them)', () => {
    const stray = trace.getTracer('bg').startSpan('stray');
    stray.end();
    assert.equal(exporter.getFinishedSpans().length, 1);
  });
});
