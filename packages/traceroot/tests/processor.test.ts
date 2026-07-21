import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
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

  describe('starts_path propagation', () => {
    it('root span gets empty starts_path', async () => {
      const tracer = trace.getTracer('test');
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (span) => {
          span.end();
          resolve();
        });
      });
      const [span] = exporter.getFinishedSpans();
      assert.deepEqual(span.attributes['traceroot.span.starts_path'], []);
    });

    it('child starts_path includes parent start time in epoch nanoseconds', async () => {
      const tracer = trace.getTracer('test');
      let rootStartTime: [number, number] | undefined;
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rootStartTime = (root as any).startTime;
          tracer.startActiveSpan('child', (child) => {
            child.end();
            root.end();
            resolve();
          });
        });
      });
      const [child] = exporter.getFinishedSpans();
      const childStartsPath = child.attributes['traceroot.span.starts_path'] as string[];
      assert.ok(Array.isArray(childStartsPath), 'starts_path should be an array');
      assert.equal(childStartsPath.length, 1, 'child of root should have 1 item in starts_path');

      // Verify the exact encoding: epoch nanoseconds as string with no precision loss
      if (rootStartTime && rootStartTime.length >= 2) {
        const [seconds, nanos] = rootStartTime;
        const expectedNs = `${seconds}${String(nanos).padStart(9, '0')}`;
        assert.equal(
          childStartsPath[0],
          expectedNs,
          'starts_path[0] should be epoch nanoseconds (19 digits max)',
        );
        // Verify string has no float rounding: exactly 10+9=19 digits (or less if seconds is < 10 digits)
        assert.equal(
          childStartsPath[0].length,
          expectedNs.length,
          'nanosecond encoding should preserve exact digit count',
        );
      }
    });

    it('deeply nested span accumulates full ancestor start time chain', async () => {
      const tracer = trace.getTracer('test');
      const startTimes: Array<[number, number]> = [];
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          startTimes.push((root as any).startTime);
          tracer.startActiveSpan('mid', (mid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            startTimes.push((mid as any).startTime);
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
      const leafStartsPath = leaf.attributes['traceroot.span.starts_path'] as string[];
      assert.equal(leafStartsPath.length, 2, 'leaf should have 2 ancestors');

      // Verify each encoded start time matches the expected format
      for (let i = 0; i < startTimes.length; i++) {
        const [seconds, nanos] = startTimes[i];
        const expectedNs = `${seconds}${String(nanos).padStart(9, '0')}`;
        assert.equal(
          leafStartsPath[i],
          expectedNs,
          `starts_path[${i}] should match encoded ancestor start time`,
        );
      }
    });

    it('starts_path length always equals ids_path length', async () => {
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
      const spans = exporter.getFinishedSpans();
      for (const span of spans) {
        const idsPath = span.attributes['traceroot.span.ids_path'] as string[];
        const startsPath = span.attributes['traceroot.span.starts_path'] as string[];
        assert.equal(
          startsPath.length,
          idsPath.length,
          `${span.name}: starts_path.length (${startsPath.length}) must equal ids_path.length (${idsPath.length})`,
        );
      }
    });

    it('remote parent child inherits starts_path from map', async () => {
      const tracer = trace.getTracer('test');
      let rootStartTime: [number, number] | undefined;
      let midStartTime: [number, number] | undefined;
      let midId: string;

      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rootStartTime = (root as any).startTime;
          tracer.startActiveSpan('mid', (mid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            midStartTime = (mid as any).startTime;
            midId = mid.spanContext().spanId;

            // Simulate OpenInference: remote parent with no attributes
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
      const leafStartsPath = leaf.attributes['traceroot.span.starts_path'] as string[];
      assert.equal(leafStartsPath.length, 2, 'leaf should inherit full ancestor chain via map');

      // Verify correct encoding of both ancestor times
      if (rootStartTime && rootStartTime.length >= 2) {
        const [rootSeconds, rootNanos] = rootStartTime;
        const expectedRootNs = `${rootSeconds}${String(rootNanos).padStart(9, '0')}`;
        assert.equal(leafStartsPath[0], expectedRootNs, 'starts_path[0] should be root start time');
      }
      if (midStartTime && midStartTime.length >= 2) {
        const [midSeconds, midNanos] = midStartTime;
        const expectedMidNs = `${midSeconds}${String(midNanos).padStart(9, '0')}`;
        assert.equal(leafStartsPath[1], expectedMidNs, 'starts_path[1] should be mid start time');
      }
    });

    it('multiple remote children inherit same starts_path', async () => {
      const tracer = trace.getTracer('test');
      let rootStartTime: [number, number] | undefined;
      let midStartTime: [number, number] | undefined;
      let midId: string;

      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rootStartTime = (root as any).startTime;
          tracer.startActiveSpan('mid', (mid) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            midStartTime = (mid as any).startTime;
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

      const c1Starts = c1.attributes['traceroot.span.starts_path'] as string[];
      const c2Starts = c2.attributes['traceroot.span.starts_path'] as string[];

      assert.equal(c1Starts.length, 2, 'child1 should have 2 ancestors');
      assert.equal(c2Starts.length, 2, 'child2 should have 2 ancestors');
      assert.deepEqual(c1Starts, c2Starts, 'both children should have identical starts_path');

      // Verify they match expected times
      if (rootStartTime && rootStartTime.length >= 2) {
        const [rootSeconds, rootNanos] = rootStartTime;
        const expectedRootNs = `${rootSeconds}${String(rootNanos).padStart(9, '0')}`;
        assert.equal(
          c1Starts[0],
          expectedRootNs,
          'child1 starts_path[0] should be root start time',
        );
        assert.equal(
          c2Starts[0],
          expectedRootNs,
          'child2 starts_path[0] should be root start time',
        );
      }
      if (midStartTime && midStartTime.length >= 2) {
        const [midSeconds, midNanos] = midStartTime;
        const expectedMidNs = `${midSeconds}${String(midNanos).padStart(9, '0')}`;
        assert.equal(c1Starts[1], expectedMidNs, 'child1 starts_path[1] should be mid start time');
        assert.equal(c2Starts[1], expectedMidNs, 'child2 starts_path[1] should be mid start time');
      }
    });

    it('span start times are encoded as 19-digit epoch nanoseconds with no precision loss', async () => {
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
      const childStartsPath = child.attributes['traceroot.span.starts_path'] as string[];
      if (childStartsPath.length > 0) {
        const encoded = childStartsPath[0];
        // Verify it's a numeric string (all digits)
        assert.match(
          encoded,
          /^\d+$/,
          'encoded nanosecond should be all digits (no decimal point)',
        );
        // Verify the length is reasonable (should be ~19 digits for current epoch, less for seconds < 10 digits)
        assert.ok(
          encoded.length >= 18 && encoded.length <= 19,
          'encoded nanosecond should be 18-19 digits',
        );
      }
    });

    it('attribute fallback reconstructs full chain with parent not in second processor map', async () => {
      // Test the attribute fallback scenario: a real parent span stamped with attributes
      // under one processor, then a child started under a SECOND processor that has no
      // parent in its map. The child must reconstruct the full starts chain from the
      // parent's attributes + parent's own startTime (attribute fallback branch).
      //
      // This is reachable: (a) parent ended and deleted from map, (b) multi-processor
      // scenario, (c) parent from an older SDK version streamed to child from another source.

      const tracer = trace.getTracer('test');
      let rootSpan: any;

      // Create parent under the FIRST processor (gets stamped with traceroot.span.* attributes)
      await new Promise<void>((resolve) => {
        tracer.startActiveSpan('root', (root) => {
          rootSpan = root;
          root.end();
          resolve();
        });
      });

      // Verify parent got the attributes from FIRST processor
      const [parentExported] = exporter.getFinishedSpans();
      assert.ok(
        parentExported.attributes['traceroot.span.path'],
        'parent should have path attribute',
      );
      assert.ok(
        parentExported.attributes['traceroot.span.ids_path'],
        'parent should have ids_path attribute',
      );
      assert.ok(
        parentExported.attributes['traceroot.span.starts_path'],
        'parent should have starts_path attribute',
      );

      // Create a SECOND processor that doesn't have the parent in its map
      const secondExporter = new InMemorySpanExporter();
      const secondInner = new SimpleSpanProcessor(secondExporter);
      const secondProvider = new NodeTracerProvider();
      secondProvider.addSpanProcessor(new TraceRootSpanProcessor(secondInner));

      // Start child under SECOND processor with parent passed via trace.setSpan
      // (NOT trace.setSpanContext — that produces NonRecordingSpan with no attributes)
      const secondTracer = secondProvider.getTracer('test');
      await new Promise<void>((resolve) => {
        const parentCtx = trace.setSpan(context.active(), rootSpan);
        const child = secondTracer.startSpan('child', {}, parentCtx);
        child.end();
        resolve();
      });

      const childSpans = secondExporter.getFinishedSpans();
      assert.equal(childSpans.length, 1, 'should have exported one child');
      const child = childSpans[0];

      const childIdsPath = child.attributes['traceroot.span.ids_path'] as string[];
      const childStartsPath = child.attributes['traceroot.span.starts_path'] as string[];

      // CRITICAL: both paths must be non-empty (parent resolved via attribute fallback)
      // and lengths must match (alignment guard + fallback working)
      assert.ok(
        childIdsPath.length > 0,
        'child ids_path should be non-empty (parent resolved via fallback)',
      );
      assert.equal(
        childStartsPath.length,
        childIdsPath.length,
        'attribute fallback: starts_path.length must equal ids_path.length',
      );

      // The parent's own start time must be the LAST element of starts_path
      // (reconstructed from parent's startTime by fallback logic)
      if (rootSpan && rootSpan.startTime && rootSpan.startTime.length >= 2) {
        const [rootSeconds, rootNanos] = rootSpan.startTime;
        const expectedRootNs = `${rootSeconds}${String(rootNanos).padStart(9, '0')}`;
        assert.equal(
          childStartsPath[childStartsPath.length - 1],
          expectedRootNs,
          'last element of starts_path should be parent own start (reconstructed via attribute fallback)',
        );
      }

      await secondProvider.shutdown();
      secondExporter.reset();
    });

    it('malformed parent starts_path attribute never throws inside onStart', async () => {
      // `attributes` is an untrusted boundary: an instrumented app can set
      // traceroot.span.starts_path to any AttributeValue. Before the Array.isArray
      // check, a non-iterable value (number, null, object) threw a TypeError inside
      // onStart — which runs synchronously inside the caller's startSpan(), so the
      // throw escaped into application code instead of merely dropping a span.
      // A bare string did not throw but spread into single characters, and only the
      // length-alignment guard kept that from being emitted.
      //
      // Every malformed shape must now degrade to [] without throwing.
      const malformed: [string, unknown][] = [
        ['number', 12345],
        ['null', null],
        ['object', {}],
        ['bare string', 'not-an-array'],
        ['mixed array', ['1752259320784000000', 42]],
      ];

      for (const [label, badValue] of malformed) {
        const parentExporter = new InMemorySpanExporter();
        const parentProvider = new NodeTracerProvider();
        parentProvider.addSpanProcessor(new SimpleSpanProcessor(parentExporter)); // NO TraceRootSpanProcessor

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let craftedParentSpan: any;
        await new Promise<void>((resolve) => {
          parentProvider.getTracer('test').startActiveSpan('parent', (parent) => {
            craftedParentSpan = parent;
            parent.setAttributes({
              'traceroot.span.path': ['root'],
              'traceroot.span.ids_path': ['aaaaaaaaaaaaaaaa'],
            });
            // Assign directly: setAttribute would reject some of these shapes before
            // they ever reach the processor, and we need the raw value in place.
            craftedParentSpan.attributes['traceroot.span.starts_path'] = badValue;
            parent.end();
            resolve();
          });
        });

        const childExporter = new InMemorySpanExporter();
        const childProvider = new NodeTracerProvider();
        childProvider.addSpanProcessor(
          new TraceRootSpanProcessor(new SimpleSpanProcessor(childExporter)),
        );
        const childContext = trace.setSpan(context.active(), craftedParentSpan);

        assert.doesNotThrow(() => {
          const child = childProvider.getTracer('test').startSpan('child', {}, childContext);
          child.end();
        }, `malformed starts_path (${label}) must not throw inside onStart`);

        const child = childExporter.getFinishedSpans()[0];
        assert.deepEqual(
          child.attributes['traceroot.span.starts_path'],
          [],
          `malformed starts_path (${label}) must degrade to []`,
        );

        await childProvider.shutdown();
        await parentProvider.shutdown();
      }
    });

    it('alignment guard degrades starts_path to [] when parent lacks starts_path attribute (old SDK)', async () => {
      // Test the explicit alignment guard: when a parent has traceroot.span.path
      // (gate opens, ids_path gets an entry) but NO traceroot.span.starts_path
      // attribute (e.g., old SDK parent), the fallback finds undefined, and the guard
      // fires: starts_path degrades to [] while ids_path has 1 entry.
      //
      // This is reachable: parents from old SDK versions, or spans stamped by
      // processors that don't set starts_path.

      // Create parent WITHOUT TraceRootSpanProcessor (so we can set attributes manually)
      const parentExporter = new InMemorySpanExporter();
      const parentInner = new SimpleSpanProcessor(parentExporter);
      const parentProvider = new NodeTracerProvider();
      parentProvider.addSpanProcessor(parentInner); // NO TraceRootSpanProcessor

      const parentTracer = parentProvider.getTracer('test');
      let craftedParentSpan: any;

      await new Promise<void>((resolve) => {
        parentTracer.startActiveSpan('parent', (parent) => {
          craftedParentSpan = parent;
          // Manually set INCONSISTENT attributes (ids_path length 2, starts_path length 0)
          parent.setAttributes({
            'traceroot.span.path': ['root', 'mid'],
            'traceroot.span.ids_path': ['id_a', 'id_b'],
            'traceroot.span.starts_path': [], // PRESENT but EMPTY (the key: defined!)
          });
          parent.end();
          resolve();
        });
      });

      // Now create child under a provider WITH TraceRootSpanProcessor
      const childExporter = new InMemorySpanExporter();
      const childInner = new SimpleSpanProcessor(childExporter);
      const childProvider = new NodeTracerProvider();
      childProvider.addSpanProcessor(new TraceRootSpanProcessor(childInner));

      const childTracer = childProvider.getTracer('test');
      const childContext = trace.setSpan(context.active(), craftedParentSpan);

      await new Promise<void>((resolve) => {
        const child = childTracer.startSpan('child', {}, childContext);
        child.end();
        resolve();
      });

      const childSpans = childExporter.getFinishedSpans();
      assert.equal(childSpans.length, 1, 'should have one child');
      const child = childSpans[0];

      const childIdsPath = child.attributes['traceroot.span.ids_path'] as string[];
      const childStartsPath = child.attributes['traceroot.span.starts_path'] as string[];

      // CRITICAL: verify the guard fired by checking the MISMATCH it prevented.
      // Without the guard: starts_path would be [parentStartNs] (length 1) while ids_path
      // is [id_a, id_b, parentId] (length 3) — a 1-vs-3 mismatch that breaks frontend.
      assert.deepEqual(
        childStartsPath,
        [],
        'alignment guard: starts_path should be [] (guard fired)',
      );
      assert.equal(
        childIdsPath.length,
        3,
        'ids_path should have 3 entries (gate opened, child added)',
      );
      assert.notEqual(
        childStartsPath.length,
        childIdsPath.length,
        'the guard suppressed a length mismatch (1 vs 3)',
      );

      await parentProvider.shutdown();
      await childProvider.shutdown();
      parentExporter.reset();
      childExporter.reset();
    });
  });
});
