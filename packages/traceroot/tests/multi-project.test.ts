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
import { _resetSpansState } from '../src/spans';

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

  it('context value wins over the parent map (no cross-stamping between roots)', () => {
    const tracer = trace.getTracer('t');
    const rootA = tracer.startSpan('root-a', undefined, contextWithProjectId(ROOT_CONTEXT, 'proj-a'));
    const rootB = tracer.startSpan('root-b', undefined, contextWithProjectId(ROOT_CONTEXT, 'proj-b'));
    const childB = tracer.startSpan(
      'child-b',
      undefined,
      contextWithProjectId(trace.setSpan(ROOT_CONTEXT, rootB), 'proj-b'),
    );
    childB.end();
    rootB.end();
    rootA.end();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.find((s) => s.name === 'root-a')?.attributes[PROJECT_ID_ATTR], 'proj-a');
    assert.equal(spans.find((s) => s.name === 'root-b')?.attributes[PROJECT_ID_ATTR], 'proj-b');
    assert.equal(spans.find((s) => s.name === 'child-b')?.attributes[PROJECT_ID_ATTR], 'proj-b');
  });
});
