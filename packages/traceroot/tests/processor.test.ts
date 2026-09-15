import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { context, propagation, trace, TraceFlags } from '@opentelemetry/api';
import { TraceRootSpanProcessor, SDK_VERSION } from '../src/processor';

describe('TraceRootSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const inner = new SimpleSpanProcessor(exporter);
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new TraceRootSpanProcessor(inner));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    // Reset global OTel state so each test gets a clean slate
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('injects traceroot.sdk.name on every span', async () => {
    const tracer = trace.getTracer('test');
    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('test-span', (span) => {
        span.end();
        resolve();
      });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.sdk.name'], 'traceroot-ts');
  });

  it('injects traceroot.sdk.version on every span', async () => {
    const tracer = trace.getTracer('test');
    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('test-span', (span) => {
        span.end();
        resolve();
      });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.sdk.version'], SDK_VERSION);
  });

  it('still exports the span through the inner processor', async () => {
    const tracer = trace.getTracer('test');
    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('test-span', (span) => {
        span.end();
        resolve();
      });
    });
    assert.equal(exporter.getFinishedSpans().length, 1);
  });

  describe('span path propagation', () => {
    it('root span gets path containing only its own name', async () => {
      const tracer = trace.getTracer('test');
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (span) => {
          span.end();
          resolve();
        });
      });
      const [span] = exporter.getFinishedSpans();
      assert.deepEqual(span.attributes['traceroot.span.path'], ['root']);
    });

    it('child span path includes parent name then own name', async () => {
      const tracer = trace.getTracer('test');
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          tracer.startActiveSpan('child', (child) => {
            child.end();
            root.end();
            resolve();
          });
        });
      });
      const [child] = exporter.getFinishedSpans();
      assert.deepEqual(child.attributes['traceroot.span.path'], ['root', 'child']);
    });

    it('deeply nested span accumulates full ancestor path', async () => {
      const tracer = trace.getTracer('test');
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          tracer.startActiveSpan('mid', (mid) => {
            tracer.startActiveSpan('leaf', (leaf) => {
              leaf.end();
              mid.end();
              root.end();
              resolve();
            });
          });
        });
      });
      const [leaf] = exporter.getFinishedSpans();
      assert.deepEqual(leaf.attributes['traceroot.span.path'], ['root', 'mid', 'leaf']);
    });
  });

  describe('ids_path propagation', () => {
    it('root span gets empty ids_path', async () => {
      const tracer = trace.getTracer('test');
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (span) => {
          span.end();
          resolve();
        });
      });
      const [span] = exporter.getFinishedSpans();
      assert.deepEqual(span.attributes['traceroot.span.ids_path'], []);
    });

    it('child ids_path contains parent span id', async () => {
      const tracer = trace.getTracer('test');
      let rootId: string;
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          rootId = root.spanContext().spanId;
          tracer.startActiveSpan('child', (child) => {
            child.end();
            root.end();
            resolve();
          });
        });
      });
      const [child] = exporter.getFinishedSpans();
      assert.deepEqual(child.attributes['traceroot.span.ids_path'], [rootId!]);
    });

    it('grandchild ids_path is [root_id, mid_id]', async () => {
      const tracer = trace.getTracer('test');
      let rootId: string;
      let midId: string;
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          rootId = root.spanContext().spanId;
          tracer.startActiveSpan('mid', (mid) => {
            midId = mid.spanContext().spanId;
            tracer.startActiveSpan('leaf', (leaf) => {
              leaf.end();
              mid.end();
              root.end();
              resolve();
            });
          });
        });
      });
      const [leaf] = exporter.getFinishedSpans();
      assert.deepEqual(leaf.attributes['traceroot.span.ids_path'], [rootId!, midId!]);
    });
  });

  describe('Map-based ancestry for remote parent contexts (OpenInference/LangGraph pattern)', () => {
    // OpenInference creates LangGraph node spans using trace.setSpanContext() rather
    // than trace.setSpan(). This produces a NonRecordingSpan as the "parent" — it has
    // a valid spanContext() but NO attributes. The Map fix allows the child to look up
    // the full ids_path by parentSpanId even when attributes are unavailable.

    it('inherits full ids_path from map when parent is a remote/NonRecordingSpan', async () => {
      const tracer = trace.getTracer('test');
      let rootId: string;
      let midId: string;

      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          rootId = root.spanContext().spanId;
          tracer.startActiveSpan('mid', (mid) => {
            midId = mid.spanContext().spanId;

            // Simulate OpenInference: replace the active span with a NonRecordingSpan
            // that has the same spanId but zero attributes.
            const remoteCtx = trace.setSpanContext(context.active(), {
              traceId: mid.spanContext().traceId,
              spanId: midId,
              traceFlags: TraceFlags.SAMPLED,
              isRemote: true,
            });
            const leaf = tracer.startSpan('leaf', {}, remoteCtx);
            leaf.end();
            mid.end();
            root.end();
            resolve();
          });
        });
      });

      const leaf = exporter.getFinishedSpans().find((s) => s.name === 'leaf')!;
      // Without map fix: would be [midId] only — root ancestry lost because
      // NonRecordingSpan carries no attributes.
      assert.deepEqual(leaf.attributes['traceroot.span.ids_path'], [rootId!, midId!]);
      assert.deepEqual(leaf.attributes['traceroot.span.path'], ['root', 'mid', 'leaf']);
    });

    it('path is also fully inherited via map for remote parent', async () => {
      const tracer = trace.getTracer('test');
      let midId: string;

      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('session', (root) => {
          tracer.startActiveSpan('agent', (mid) => {
            midId = mid.spanContext().spanId;
            const remoteCtx = trace.setSpanContext(context.active(), {
              traceId: mid.spanContext().traceId,
              spanId: midId,
              traceFlags: TraceFlags.SAMPLED,
              isRemote: true,
            });
            const llm = tracer.startSpan('llm_call', {}, remoteCtx);
            llm.end();
            mid.end();
            root.end();
            resolve();
          });
        });
      });

      const llm = exporter.getFinishedSpans().find((s) => s.name === 'llm_call')!;
      assert.deepEqual(llm.attributes['traceroot.span.path'], ['session', 'agent', 'llm_call']);
    });

    it('multiple remote children of the same parent all get correct ancestry', async () => {
      const tracer = trace.getTracer('test');
      let rootId: string;
      let midId: string;

      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          rootId = root.spanContext().spanId;
          tracer.startActiveSpan('mid', (mid) => {
            midId = mid.spanContext().spanId;
            const remoteCtx = trace.setSpanContext(context.active(), {
              traceId: mid.spanContext().traceId,
              spanId: midId,
              traceFlags: TraceFlags.SAMPLED,
              isRemote: true,
            });
            const child1 = tracer.startSpan('child1', {}, remoteCtx);
            const child2 = tracer.startSpan('child2', {}, remoteCtx);
            child1.end();
            child2.end();
            mid.end();
            root.end();
            resolve();
          });
        });
      });

      const finished = exporter.getFinishedSpans();
      const c1 = finished.find((s) => s.name === 'child1')!;
      const c2 = finished.find((s) => s.name === 'child2')!;
      assert.deepEqual(c1.attributes['traceroot.span.ids_path'], [rootId!, midId!]);
      assert.deepEqual(c2.attributes['traceroot.span.ids_path'], [rootId!, midId!]);
    });
  });
});

describe('TraceRootSpanProcessor globalAttributes (integration)', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  function setup(makeInner: (e: InMemorySpanExporter) => SpanProcessor): void {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(
      new TraceRootSpanProcessor(makeInner(exporter), {
        globalAttributes: { 'traceroot.source': 'detector' },
      }),
    );
    provider.register();
  }

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('stamps globalAttributes on both root and child spans (simple processor)', async () => {
    setup((e) => new SimpleSpanProcessor(e));
    const tracer = trace.getTracer('test');
    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('root', (root) => {
        tracer.startActiveSpan('child', (child) => {
          child.end();
          root.end();
          resolve();
        });
      });
    });
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    for (const s of spans) {
      assert.equal(s.attributes['traceroot.source'], 'detector');
    }
  });

  it('stamps globalAttributes on every span across batches (batch processor)', async () => {
    setup((e) => new BatchSpanProcessor(e, { maxExportBatchSize: 2, scheduledDelayMillis: 5 }));
    const tracer = trace.getTracer('test');
    for (let i = 0; i < 5; i++) {
      tracer.startSpan(`span-${i}`).end();
    }
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 5);
    for (const s of spans) {
      assert.equal(s.attributes['traceroot.source'], 'detector');
    }
  });
});

describe('TraceRootSpanProcessor exportSpan', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  function register(exportSpan: (span: { name: string }) => boolean): void {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(
      new TraceRootSpanProcessor(new SimpleSpanProcessor(exporter), { exportSpan }),
    );
    provider.register();
  }

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('drops the spans the predicate refuses and keeps the rest, children included', () => {
    register((span) => !span.name.startsWith('Sandbox.'));
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('agent', (root) => {
      tracer.startActiveSpan('Sandbox.refreshData', (noise) => noise.end());
      tracer.startActiveSpan('bash', (tool) => tool.end());
      root.end();
    });
    const names = exporter.getFinishedSpans().map((s) => s.name);
    assert.deepEqual(names, ['bash', 'agent']);
  });

  it('a kept child of a dropped span still exports, with its parent id intact', () => {
    register((span) => span.name !== 'dropped-parent');
    const tracer = trace.getTracer('test');
    let parentId = '';
    tracer.startActiveSpan('dropped-parent', (parent) => {
      parentId = parent.spanContext().spanId;
      tracer.startActiveSpan('kept-child', (child) => child.end());
      parent.end();
    });
    const [child] = exporter.getFinishedSpans();
    assert.equal(child.name, 'kept-child');
    assert.equal(child.parentSpanContext?.spanId, parentId);
  });

  it('a throwing predicate exports the span rather than failing the host', () => {
    register(() => {
      throw new Error('filter bug');
    });
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('survives', (span) => span.end());
    assert.equal(exporter.getFinishedSpans().length, 1);
  });
});
