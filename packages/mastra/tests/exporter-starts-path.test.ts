import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import type { AnyExportedSpan } from '@mastra/core/observability';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { TraceRootExporter } from '../src/exporter';

// ---------------------------------------------------------------------------
// Capturing exporter — injected via _spanExporter to avoid OTLP network calls
// ---------------------------------------------------------------------------

class CapturingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (result: { code: number }) => void): void {
    this.spans.push(...spans);
    cb({ code: 0 });
  }
  async shutdown(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 2000;
function uid(): string {
  return (++_seq).toString(16).padStart(16, '0');
}

function makeRig() {
  const capture = new CapturingExporter();
  const exporter = new TraceRootExporter({
    apiKey: 'test-key',
    disableBatch: true,
    _spanExporter: capture,
  });
  exporter.init({ config: { serviceName: 'test' } } as Parameters<typeof exporter.init>[0]);
  return { exporter, capture };
}

function makeSpan(opts: {
  id?: string;
  traceId?: string;
  parentSpanId?: string;
  name?: string;
  type?: SpanType;
  isEvent?: boolean;
  startTime?: Date;
}): AnyExportedSpan {
  const now = opts.startTime ?? new Date();
  return {
    id: opts.id ?? uid(),
    traceId: opts.traceId ?? uid(),
    parentSpanId: opts.parentSpanId,
    name: opts.name ?? 'span',
    type: opts.type ?? SpanType.AGENT_RUN,
    isEvent: opts.isEvent ?? false,
    isRootSpan: !opts.parentSpanId,
    startTime: now,
    endTime: new Date(now.getTime() + 10),
    input: undefined,
    output: undefined,
    metadata: undefined,
    errorInfo: undefined,
    attributes: undefined,
    requestContext: undefined,
  } as unknown as AnyExportedSpan;
}

async function startSpan(exporter: TraceRootExporter, span: AnyExportedSpan): Promise<void> {
  await (
    exporter as unknown as { _exportTracingEvent(e: unknown): Promise<void> }
  )._exportTracingEvent({
    type: TracingEventType.SPAN_STARTED,
    exportedSpan: span,
  });
}

async function endSpan(exporter: TraceRootExporter, span: AnyExportedSpan): Promise<void> {
  await (
    exporter as unknown as { _exportTracingEvent(e: unknown): Promise<void> }
  )._exportTracingEvent({
    type: TracingEventType.SPAN_ENDED,
    exportedSpan: span,
  });
}

async function runSpan(exporter: TraceRootExporter, span: AnyExportedSpan): Promise<void> {
  await startSpan(exporter, span);
  await endSpan(exporter, span);
}

function getAttrs(capture: CapturingExporter, index?: number): Record<string, unknown> {
  const i = index ?? capture.spans.length - 1;
  return (capture.spans[i]?.attributes ?? {}) as Record<string, unknown>;
}

function startsPathMap(exporter: TraceRootExporter) {
  const e = exporter as unknown as {
    _startsPathBySpanId: Map<string, string[]>;
  };
  return e._startsPathBySpanId;
}

// ---------------------------------------------------------------------------
// 1. Basic starts_path computation
// ---------------------------------------------------------------------------

describe('starts_path computation', () => {
  it('root span: starts_path=[]', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'agent-run' });
    await runSpan(exporter, root);
    const attrs = getAttrs(capture);
    assert.deepEqual(attrs['traceroot.span.starts_path'], []);
  });

  it('child span: starts_path=[root.startTimeNs]', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const rootTime = new Date('2025-01-15T10:30:45.123Z');
    const root = makeSpan({ traceId, name: 'agent-run', startTime: rootTime });
    const child = makeSpan({ traceId, parentSpanId: root.id, name: 'model-gen' });
    await startSpan(exporter, root);
    await startSpan(exporter, child);
    await endSpan(exporter, child);
    const attrs = getAttrs(capture);
    assert.deepEqual(attrs['traceroot.span.starts_path'], [`${rootTime.getTime()}000000`]);
  });

  it('grandchild span: starts_path=[root.startTimeNs, child.startTimeNs]', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const rootTime = new Date('2025-01-15T10:30:45.123Z');
    const childTime = new Date('2025-01-15T10:30:46.456Z');
    const root = makeSpan({ traceId, name: 'agent-run', startTime: rootTime });
    const child = makeSpan({
      traceId,
      parentSpanId: root.id,
      name: 'model-gen',
      startTime: childTime,
    });
    const grandchild = makeSpan({
      traceId,
      parentSpanId: child.id,
      name: 'model-step',
    });
    await startSpan(exporter, root);
    await startSpan(exporter, child);
    await startSpan(exporter, grandchild);
    await endSpan(exporter, grandchild);
    const attrs = getAttrs(capture);
    assert.deepEqual(attrs['traceroot.span.starts_path'], [
      `${rootTime.getTime()}000000`,
      `${childTime.getTime()}000000`,
    ]);
  });

  it('siblings get independent starts_path', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const rootTime = new Date('2025-01-15T10:30:45.000Z');
    const root = makeSpan({ traceId, name: 'agent-run', startTime: rootTime });
    const s1 = makeSpan({ traceId, parentSpanId: root.id, name: 'step-1' });
    const s2 = makeSpan({ traceId, parentSpanId: root.id, name: 'step-2' });
    await startSpan(exporter, root);
    await startSpan(exporter, s1);
    await startSpan(exporter, s2);
    await endSpan(exporter, s1);
    await endSpan(exporter, s2);
    // Both siblings should have the same root start time in their starts_path
    assert.deepEqual(getAttrs(capture, 0)['traceroot.span.starts_path'], [
      `${rootTime.getTime()}000000`,
    ]);
    assert.deepEqual(getAttrs(capture, 1)['traceroot.span.starts_path'], [
      `${rootTime.getTime()}000000`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. ms→ns encoding correctness
// ---------------------------------------------------------------------------

describe('ms→ns encoding', () => {
  it('encodes milliseconds to nanoseconds as string: ms * 1_000_000', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const rootTime = new Date('2025-01-15T10:30:45.789Z'); // 789 ms
    const root = makeSpan({ traceId, name: 'root', startTime: rootTime });
    const child = makeSpan({ traceId, parentSpanId: root.id, name: 'child' });
    await startSpan(exporter, root);
    await startSpan(exporter, child);
    await endSpan(exporter, child);
    const attrs = getAttrs(capture);
    const startsPath = attrs['traceroot.span.starts_path'] as string[];
    const rootStartMs = rootTime.getTime();
    const expectedNs = `${rootStartMs}000000`;
    assert.equal(startsPath[0], expectedNs, 'should encode as string: ms + 6 zeros');
  });

  it('produces 19-digit decimal string (epoch-ns)', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const rootTime = new Date(); // current time
    const root = makeSpan({ traceId, name: 'root', startTime: rootTime });
    const child = makeSpan({ traceId, parentSpanId: root.id, name: 'child' });
    await startSpan(exporter, root);
    await startSpan(exporter, child);
    await endSpan(exporter, child);
    const attrs = getAttrs(capture);
    const startsPath = attrs['traceroot.span.starts_path'] as string[];
    assert.ok(startsPath.length > 0);
    const nsString = startsPath[0];
    // epoch-ns is ~1.7e18, so ~19 digits
    assert.ok(nsString.match(/^\d{19}$/), `${nsString} should be exactly 19 decimal digits`);
  });

  it('is always a string, never a number', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'root' });
    const child = makeSpan({ traceId, parentSpanId: root.id, name: 'child' });
    await startSpan(exporter, root);
    await startSpan(exporter, child);
    await endSpan(exporter, child);
    const attrs = getAttrs(capture);
    const startsPath = attrs['traceroot.span.starts_path'] as string[];
    assert.ok(typeof startsPath[0] === 'string');
  });
});

// ---------------------------------------------------------------------------
// 3. Gating logic: starts_path mirrors ids_path gate
// ---------------------------------------------------------------------------

describe('gating: starts_path mirrors ids_path', () => {
  it('orphaned child (unknown parent): starts_path=[]', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const orphan = makeSpan({ traceId, parentSpanId: uid(), name: 'orphan' });
    await runSpan(exporter, orphan);
    const attrs = getAttrs(capture);
    assert.deepEqual(attrs['traceroot.span.starts_path'], []);
    // Verify ids_path is also [] (they should gate the same way)
    assert.deepEqual(attrs['traceroot.span.ids_path'], []);
  });

  it('starts_path.length === ids_path.length always', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'root' });
    const child = makeSpan({ traceId, parentSpanId: root.id, name: 'child' });
    const grandchild = makeSpan({ traceId, parentSpanId: child.id, name: 'grandchild' });
    const untracked = makeSpan({ traceId, parentSpanId: uid(), name: 'untracked' });

    await startSpan(exporter, root);
    await startSpan(exporter, child);
    await startSpan(exporter, grandchild);
    await runSpan(exporter, untracked);

    await endSpan(exporter, grandchild);
    await endSpan(exporter, child);

    // Check all exported spans: length invariant must hold
    for (let i = 0; i < capture.spans.length; i++) {
      const attrs = getAttrs(capture, i);
      const startsPath = attrs['traceroot.span.starts_path'] as string[] | undefined;
      const idsPath = attrs['traceroot.span.ids_path'] as string[] | undefined;
      if (startsPath !== undefined && idsPath !== undefined) {
        assert.equal(
          startsPath.length,
          idsPath.length,
          `at index ${i}: starts_path.length should equal ids_path.length`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Cleanup at all three sites
// ---------------------------------------------------------------------------

describe('memory cleanup for starts_path', () => {
  it('map is empty after span ends (handleSpanEnded finally)', async () => {
    const { exporter } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'root' });
    await runSpan(exporter, root);
    const map = startsPathMap(exporter);
    assert.equal(map.size, 0, 'map should be empty after span ends');
  });

  it('nested spans clean up map progressively on each end', async () => {
    const { exporter } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'root' });
    const child = makeSpan({ traceId, parentSpanId: root.id, name: 'child' });
    await startSpan(exporter, root);
    await startSpan(exporter, child);

    const map = startsPathMap(exporter);
    assert.equal(map.size, 2, 'both spans in map after start');

    await endSpan(exporter, child);
    assert.equal(map.size, 1, 'child cleaned after end');

    await endSpan(exporter, root);
    assert.equal(map.size, 0, 'root cleaned after end');
  });

  it('shutdown clears map even for in-flight spans', async () => {
    const { exporter } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'root' });
    await startSpan(exporter, root);
    const map = startsPathMap(exporter);
    assert.equal(map.size, 1);
    await exporter.shutdown();
    assert.equal(map.size, 0, 'map cleared by shutdown');
  });

  it('TTL eviction cleans up stale starts_path entries', async () => {
    const { exporter } = makeRig();

    // Create 65 orphaned traces (above SWEEP_THRESHOLD=64)
    for (let i = 0; i < 65; i++) {
      await startSpan(exporter, makeSpan({ name: `orphan-${i}` }));
    }

    const mapBefore = startsPathMap(exporter);
    assert.equal(mapBefore.size, 65);

    // Backdate all traces past TTL
    const longAgo = Date.now() - 10 * 60 * 1000;
    const reach = exporter as unknown as {
      traceMap: Map<string, { lastTouched: number }>;
    };
    for (const state of reach.traceMap.values()) {
      state.lastTouched = longAgo;
    }

    // Trigger sweep
    await startSpan(exporter, makeSpan({ name: 'fresh' }));

    const mapAfter = startsPathMap(exporter);
    assert.equal(mapAfter.size, 1, 'stale entries swept, only fresh span remains');
  });
});

// ---------------------------------------------------------------------------
// 5. Co-existence with path and ids_path
// ---------------------------------------------------------------------------

describe('starts_path co-existence with path and ids_path', () => {
  it('all three path attrs present together on child span', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'agent-run' });
    const child = makeSpan({ traceId, parentSpanId: root.id, name: 'model-gen' });
    await startSpan(exporter, root);
    await startSpan(exporter, child);
    await endSpan(exporter, child);
    const attrs = getAttrs(capture);
    assert.ok(Array.isArray(attrs['traceroot.span.path']));
    assert.ok(Array.isArray(attrs['traceroot.span.ids_path']));
    assert.ok(Array.isArray(attrs['traceroot.span.starts_path']));
  });

  it('root span: path and ids_path non-empty, starts_path empty', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'root' });
    await runSpan(exporter, root);
    const attrs = getAttrs(capture);
    assert.deepEqual(attrs['traceroot.span.path'], ['root']);
    assert.deepEqual(attrs['traceroot.span.ids_path'], []);
    assert.deepEqual(attrs['traceroot.span.starts_path'], []);
  });

  it('event span: no starts_path attr', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const root = makeSpan({ traceId, name: 'root' });
    const evt = makeSpan({ traceId, parentSpanId: root.id, name: 'chunk', isEvent: true });
    await startSpan(exporter, root);
    await startSpan(exporter, evt);
    await endSpan(exporter, evt);
    const attrs = getAttrs(capture);
    assert.equal(attrs['traceroot.span.starts_path'], undefined);
  });
});

// ---------------------------------------------------------------------------
// 6. Out-of-order ending
// ---------------------------------------------------------------------------

describe('out-of-order ending preserves starts_path', () => {
  it('child starts_path survives parent ending first', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const rootTime = new Date('2025-01-15T10:30:45.000Z');
    const parent = makeSpan({ traceId, name: 'parent', startTime: rootTime });
    const child = makeSpan({ traceId, parentSpanId: parent.id, name: 'child' });

    await startSpan(exporter, parent);
    await startSpan(exporter, child);
    await endSpan(exporter, parent); // parent ends first
    await endSpan(exporter, child); // child ends after

    // child should still have correct starts_path
    assert.deepEqual(getAttrs(capture, 1)['traceroot.span.starts_path'], [
      `${rootTime.getTime()}000000`,
    ]);
  });

  it('grandchild starts_path survives parent and grandparent ending first', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const rootTime = new Date('2025-01-15T10:30:45.100Z');
    const midTime = new Date('2025-01-15T10:30:46.200Z');
    const root = makeSpan({ traceId, name: 'root', startTime: rootTime });
    const mid = makeSpan({
      traceId,
      parentSpanId: root.id,
      name: 'mid',
      startTime: midTime,
    });
    const leaf = makeSpan({ traceId, parentSpanId: mid.id, name: 'leaf' });

    await startSpan(exporter, root);
    await startSpan(exporter, mid);
    await startSpan(exporter, leaf);
    await endSpan(exporter, root);
    await endSpan(exporter, mid);
    await endSpan(exporter, leaf);

    const leafAttrs = getAttrs(capture, 2);
    assert.deepEqual(leafAttrs['traceroot.span.starts_path'], [
      `${rootTime.getTime()}000000`,
      `${midTime.getTime()}000000`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. Deep nesting
// ---------------------------------------------------------------------------

describe('deep nesting with starts_path', () => {
  it('10-level hierarchy: leaf gets correct starts_path with 9 ancestors', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const times: Date[] = [];
    const spans: AnyExportedSpan[] = [];

    for (let i = 0; i < 10; i++) {
      const time = new Date(Date.now() + i * 1000); // each 1s apart
      times.push(time);
      spans.push(
        makeSpan({ traceId, parentSpanId: spans[i - 1]?.id, name: `level-${i}`, startTime: time }),
      );
    }

    for (const span of spans) await startSpan(exporter, span);
    await endSpan(exporter, spans[9]);

    const attrs = getAttrs(capture);
    const startsPath = attrs['traceroot.span.starts_path'] as string[];
    assert.equal(startsPath.length, 9, 'should have 9 ancestor start times');
    for (let i = 0; i < 9; i++) {
      assert.equal(startsPath[i], `${times[i].getTime()}000000`);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. SPAN_ENDED without SPAN_STARTED
// ---------------------------------------------------------------------------

describe('SPAN_ENDED without SPAN_STARTED', () => {
  it('orphaned end has no starts_path attr', async () => {
    const { exporter, capture } = makeRig();
    const span = makeSpan({ name: 'unstarted' });
    await endSpan(exporter, span);
    const attrs = getAttrs(capture);
    assert.equal(attrs['traceroot.span.starts_path'], undefined);
  });

  it('map is empty after orphaned end', async () => {
    const { exporter } = makeRig();
    const span = makeSpan({ name: 'unstarted' });
    await endSpan(exporter, span);
    const map = startsPathMap(exporter);
    assert.equal(map.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 9. Mastra span tree: AGENT_RUN → MODEL_GENERATION → MODEL_STEP
// ---------------------------------------------------------------------------

describe('Mastra span tree with starts_path', () => {
  it('AGENT_RUN → MODEL_GENERATION → MODEL_STEP gets correct starts_path chain', async () => {
    const { exporter, capture } = makeRig();
    const traceId = uid();
    const agentTime = new Date('2025-01-15T10:30:45.000Z');
    const modelTime = new Date('2025-01-15T10:30:46.500Z');

    const agentRun = makeSpan({
      traceId,
      name: 'myAgent',
      type: SpanType.AGENT_RUN,
      startTime: agentTime,
    });
    const modelGen = makeSpan({
      traceId,
      parentSpanId: agentRun.id,
      name: 'model-generation',
      type: SpanType.MODEL_GENERATION,
      startTime: modelTime,
    });
    const modelStep = makeSpan({
      traceId,
      parentSpanId: modelGen.id,
      name: 'model-step',
      type: SpanType.MODEL_STEP,
    });

    await startSpan(exporter, agentRun);
    await startSpan(exporter, modelGen);
    await startSpan(exporter, modelStep);
    await endSpan(exporter, modelStep);

    const attrs = getAttrs(capture);
    assert.deepEqual(attrs['traceroot.span.starts_path'], [
      `${agentTime.getTime()}000000`,
      `${modelTime.getTime()}000000`,
    ]);
  });
});
