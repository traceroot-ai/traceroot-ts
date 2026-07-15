// Acceptance-level tests for self-tracing: internal export mode, deterministic
// trace-id forcing, and the global source marker working TOGETHER, the way a
// trusted worker drives them: one long-lived internal-mode tracer, concurrent
// runs with trace_id = run_id, a child span per run, and the marker on every span.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { TraceRootSpanProcessor } from '../src/processor';
import { ContextIdGenerator } from '../src/trace-id';
import { startSpan, usingSpan, _resetSpansState } from '../src/spans';
import { observe } from '../src/observe';

const RUN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * Register an in-memory pipeline that mirrors initialize()'s stack
 * (ContextIdGenerator + TraceRootSpanProcessor) and flip internal mode via a
 * real initialize() call. initialize()'s own register() loses the race to the
 * already-registered test provider (OTel keeps the first global and logs diag
 * errors for the duplicate registration) — spans still flow through the
 * in-memory provider while initialize() flips internal-mode state. No OTLP
 * export ever happens in these tests.
 */
function registerHarness(globalAttributes: Record<string, string | number | boolean>): {
  exporter: InMemorySpanExporter;
  provider: NodeTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ idGenerator: new ContextIdGenerator() });
  provider.addSpanProcessor(
    new TraceRootSpanProcessor(new SimpleSpanProcessor(exporter), {
      environment: 'prod',
      globalAttributes,
    }),
  );
  provider.register();
  TraceRoot.initialize({
    disableBatch: true,
    internalExport: { path: '/api/v1/internal/traces', projectId: 'p' },
  });
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

describe('self-tracing acceptance (worker scenario)', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness({ 'traceroot.source': 'detector' }));
  });

  afterEach(() => {
    exporter.reset();
  });

  after(async () => {
    await teardownHarness(provider);
  });

  it('two concurrent runs: trace_id = run_id, marker on every span, parentless roots', async () => {
    const runDetector = (runId: string) =>
      observe({ name: 'detector-run', traceId: runId }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return observe({ name: 'judge-llm', type: 'llm' }, async () => 'verdict');
      });
    await Promise.all([runDetector(RUN_A), runDetector(RUN_B)]);

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 4);
    for (const s of spans) {
      assert.equal(s.attributes['traceroot.source'], 'detector');
    }
    for (const runId of [RUN_A, RUN_B]) {
      const group = spans.filter((s) => s.spanContext().traceId === runId);
      assert.equal(group.length, 2, `expected root+child for run ${runId}`);
      const root = group.find((s) => s.name === 'detector-run');
      const child = group.find((s) => s.name === 'judge-llm');
      assert.ok(root && child);
      assert.equal(root.parentSpanId, undefined);
      assert.equal(child.parentSpanId, root.spanContext().spanId);
    }
  });

  it('adapter shape: startSpan root with forced id + child handle, marker everywhere', () => {
    const root = startSpan({ name: 'run', traceId: RUN_A });
    const child = root.startSpan({ name: 'judge' });
    child.end();
    root.end();

    const spans = exporter.getFinishedSpans();
    const rootSpan = spans.find((s) => s.name === 'run');
    const childSpan = spans.find((s) => s.name === 'judge');
    assert.ok(rootSpan && childSpan);
    assert.equal(rootSpan.spanContext().traceId, RUN_A);
    assert.equal(childSpan.spanContext().traceId, RUN_A);
    assert.equal(rootSpan.parentSpanId, undefined);
    assert.equal(childSpan.parentSpanId, rootSpan.spanContext().spanId);
    assert.equal(rootSpan.attributes['traceroot.source'], 'detector');
    assert.equal(childSpan.attributes['traceroot.source'], 'detector');
  });

  it('forced root carries root path attributes (path=[name], ids_path=[])', () => {
    const root = startSpan({ name: 'run', traceId: RUN_A });
    root.end();
    const [s] = exporter.getFinishedSpans();
    assert.deepEqual(s.attributes['traceroot.span.path'], ['run']);
    assert.deepEqual(s.attributes['traceroot.span.ids_path'], []);
  });

  it('grandchildren inherit the forced trace id and full span path', async () => {
    await observe({ name: 'root', traceId: RUN_A }, async () =>
      observe({ name: 'child' }, async () => observe({ name: 'grandchild' }, async () => 'ok')),
    );
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 3);
    for (const s of spans) {
      assert.equal(s.spanContext().traceId, RUN_A);
    }
    const grandchild = spans.find((s) => s.name === 'grandchild');
    assert.ok(grandchild);
    assert.deepEqual(grandchild.attributes['traceroot.span.path'], ['root', 'child', 'grandchild']);
  });

  it('observe() nests under a forced startSpan root via usingSpan', async () => {
    const root = startSpan({ name: 'run', traceId: RUN_A });
    await usingSpan(root, () => observe({ name: 'step' }, async () => 'ok'));
    root.end();
    const step = exporter.getFinishedSpans().find((s) => s.name === 'step');
    assert.ok(step);
    assert.equal(step.spanContext().traceId, RUN_A);
    assert.equal(step.parentSpanId, root.spanId);
  });

  it('children created inside a forced async-generator run inherit the id', async () => {
    async function* gen(): AsyncGenerator<number> {
      yield await observe({ name: 'inner' }, async () => 1);
    }
    const items: number[] = [];
    for await (const v of observe({ name: 'gen-run', traceId: RUN_A }, gen)) {
      items.push(v);
    }
    assert.deepEqual(items, [1]);
    const spans = exporter.getFinishedSpans();
    const genRoot = spans.find((s) => s.name === 'gen-run');
    const inner = spans.find((s) => s.name === 'inner');
    assert.ok(genRoot && inner);
    assert.equal(inner.spanContext().traceId, RUN_A);
    assert.equal(inner.parentSpanId, genRoot.spanContext().spanId);
  });

  it('a failing run still exports its forced root with ERROR status', async () => {
    await assert.rejects(
      () =>
        observe({ name: 'run', traceId: RUN_A }, async () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    const s = exporter.getFinishedSpans().find((x) => x.name === 'run');
    assert.ok(s);
    assert.equal(s.spanContext().traceId, RUN_A);
    assert.equal(s.status.code, SpanStatusCode.ERROR);
    assert.equal(s.parentSpanId, undefined);
  });

  it('an unforced root created after a forced one gets a random trace id (no leakage)', () => {
    const forced = startSpan({ name: 'forced', traceId: RUN_A });
    forced.end();
    const normal = startSpan({ name: 'normal' });
    normal.end();
    assert.match(normal.traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(normal.traceId, RUN_A);
  });

  it('re-emitting the same run id forces the same trace id with fresh span ids', () => {
    const first = startSpan({ name: 'run', traceId: RUN_A });
    first.end();
    const second = startSpan({ name: 'run', traceId: RUN_A });
    second.end();
    const [a, b] = exporter.getFinishedSpans();
    assert.equal(a.spanContext().traceId, RUN_A);
    assert.equal(b.spanContext().traceId, RUN_A);
    assert.notEqual(a.spanContext().spanId, b.spanContext().spanId);
  });

  it('forced roots get fresh random 16-hex span ids', () => {
    const root = startSpan({ name: 'run', traceId: RUN_A });
    root.end();
    assert.match(root.spanId, /^[0-9a-f]{16}$/);
  });

  it('environment is dual-written on forced spans', () => {
    const root = startSpan({ name: 'run', traceId: RUN_A });
    root.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['deployment.environment'], 'prod');
    assert.equal(s.attributes['traceroot.environment'], 'prod');
  });
});

describe('forcing lifecycle across shutdown()', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness({ 'traceroot.source': 'detector' }));
  });

  after(async () => {
    await teardownHarness(provider);
  });

  it('forcing stops being honored after shutdown()', async () => {
    await TraceRoot.shutdown();
    const messages: string[] = [];
    const restore = console.warn;
    console.warn = (...a: unknown[]) => {
      messages.push(a.map(String).join(' '));
    };
    let root;
    try {
      root = startSpan({ name: 'after', traceId: RUN_A });
    } finally {
      console.warn = restore;
    }
    assert.notEqual(root.traceId, RUN_A);
    assert.ok(messages.some((m) => m.includes('internal export mode')));
    root.end();
    exporter.reset();
  });
});

describe('globalAttributes precedence', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness({
      'traceroot.span.path': 'clobber-attempt',
      'deployment.environment': 'caller-override',
      'traceroot.tier': 2,
      'traceroot.flag': true,
    }));
  });

  afterEach(() => {
    exporter.reset();
  });

  after(async () => {
    await teardownHarness(provider);
  });

  it('cannot clobber structural traceroot.span.* keys (SDK-owned)', () => {
    const root = startSpan({ name: 'run' });
    root.end();
    const [s] = exporter.getFinishedSpans();
    assert.deepEqual(s.attributes['traceroot.span.path'], ['run']);
  });

  it('caller globals win over the environment writes (documented behavior)', () => {
    const root = startSpan({ name: 'run' });
    root.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['deployment.environment'], 'caller-override');
    // The dual-write key was not targeted by the caller and keeps the SDK value.
    assert.equal(s.attributes['traceroot.environment'], 'prod');
  });

  it('number and boolean attribute values survive the real pipeline', () => {
    const root = startSpan({ name: 'run' });
    root.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['traceroot.tier'], 2);
    assert.equal(s.attributes['traceroot.flag'], true);
  });
});
