import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { context, propagation, trace, Attributes, TraceFlags } from '@opentelemetry/api';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TraceRootSpanProcessor, SDK_VERSION, REDACTABLE_KEYS } from '../src/processor';

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
    assert.equal(child.parentSpanId, parentId);
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

describe('TraceRootSpanProcessor redact', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  function register(redact?: (attributes: Attributes) => Attributes): void {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(
      new TraceRootSpanProcessor(new SimpleSpanProcessor(exporter), { redact }),
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

  it('exports the span unchanged when redact is not set', () => {
    register();
    trace.getTracer('test').startActiveSpan('plain', (span) => {
      span.setAttribute('user.email', 'a@b.com');
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['user.email'], 'a@b.com');
    assert.equal(span.attributes['traceroot.redacted'], undefined);
  });

  it('exports the redacted attributes and leaves the original span untouched', () => {
    register((attrs) => ({ ...attrs, 'user.email': '[email]' }));
    const sibling = new InMemorySpanExporter();
    provider.addSpanProcessor(new SimpleSpanProcessor(sibling));
    trace.getTracer('test').startActiveSpan('pii', (span) => {
      span.setAttribute('user.email', 'a@b.com');
      span.end();
    });
    const [exported] = exporter.getFinishedSpans();
    assert.equal(exported.attributes['user.email'], '[email]');
    assert.equal(exported.attributes['traceroot.redacted'], true);
    const [original] = sibling.getFinishedSpans();
    assert.equal(original.attributes['user.email'], 'a@b.com');
    assert.equal(original.attributes['traceroot.redacted'], undefined);
  });

  it('a redact that mutates an array in place leaves the original span unchanged', () => {
    register((attrs) => {
      (attrs['user.tags'] as string[])[0] = '[tag]';
      return attrs;
    });
    const sibling = new InMemorySpanExporter();
    provider.addSpanProcessor(new SimpleSpanProcessor(sibling));
    trace.getTracer('test').startActiveSpan('tags', (span) => {
      span.setAttribute('user.tags', ['vip']);
      span.end();
    });
    assert.deepEqual(exporter.getFinishedSpans()[0].attributes['user.tags'], ['[tag]']);
    assert.deepEqual(sibling.getFinishedSpans()[0].attributes['user.tags'], ['vip']);
  });

  it('keeps traceroot.* keys even when redact returns nothing', () => {
    register(() => ({}));
    trace.getTracer('test').startActiveSpan('ours', (span) => {
      span.setAttribute('user.email', 'a@b.com');
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['user.email'], undefined);
    assert.equal(span.attributes['traceroot.sdk.name'], 'traceroot-ts');
  });

  it('holds back the user, session, model and token keys ingest reads', () => {
    register(() => ({}));
    trace.getTracer('test').startActiveSpan('attributed', (span) => {
      span.setAttributes({
        'user.id': 'u1',
        'session.id': 's1',
        'llm.model_name': 'gpt-4o',
        'llm.token_count.prompt': 12,
      });
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['user.id'], 'u1');
    assert.equal(span.attributes['session.id'], 's1');
    assert.equal(span.attributes['llm.model_name'], 'gpt-4o');
    assert.equal(span.attributes['llm.token_count.prompt'], 12);
  });

  it('redacts recorded content keys and holds back the bookkeeping ones', () => {
    register(() => ({}));
    trace.getTracer('test').startActiveSpan('content', (span) => {
      span.setAttribute('traceroot.span.metadata', '{"email":"a@b.com"}');
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.span.metadata'], undefined);
    assert.deepEqual(span.attributes['traceroot.span.path'], ['content']);
  });

  it('a throwing redact blanks every value except numbers and booleans', () => {
    register(() => {
      throw new Error('redact bug');
    });
    trace.getTracer('test').startActiveSpan('fails-closed', (span) => {
      span.setAttributes({ 'user.email': 'a@b.com', 'user.tags': ['vip'], 'llm.tokens': 42 });
      span.setAttribute('traceroot.span.metadata', '{"email":"a@b.com"}');
      span.setAttribute('traceroot.trace.metadata', '{"email":"a@b.com"}');
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['user.email'], '[redaction failed]');
    assert.equal(span.attributes['user.tags'], '[redaction failed]');
    assert.equal(span.attributes['traceroot.span.metadata'], undefined);
    assert.equal(span.attributes['traceroot.trace.metadata'], undefined);
    assert.equal(span.attributes['llm.tokens'], 42);
  });

  it('passes eval error, score comment and model parameters to redact', () => {
    register((attrs) =>
      Object.fromEntries(
        Object.entries(attrs).map(([k, v]) => [
          k,
          typeof v === 'string' ? v.replace('a@b.com', '[email]') : v,
        ]),
      ),
    );
    trace.getTracer('test').startActiveSpan('eval', (span) => {
      span.setAttributes({
        'traceroot.eval.error': 'failed for a@b.com',
        'traceroot.eval.score_comment': 'a@b.com looked fine',
        'traceroot.llm.model_parameters': '{"user":"a@b.com"}',
      });
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    assert.ok(!JSON.stringify(span.attributes).includes('a@b.com'));
  });

  for (const [name, redact] of [
    ['returns {}', () => ({})],
    [
      'throws',
      () => {
        throw new Error('redact bug');
      },
    ],
  ] as const) {
    it(`keeps span kind and exception.type when redact ${name}`, () => {
      register(redact);
      trace.getTracer('test').startActiveSpan('kind', (span) => {
        span.setAttributes({ 'openinference.span.kind': 'LLM', 'gen_ai.operation.name': 'chat' });
        span.recordException(new TypeError('bad input from a@b.com'));
        span.end();
      });
      const [span] = exporter.getFinishedSpans();
      assert.equal(span.attributes['openinference.span.kind'], 'LLM');
      assert.equal(span.attributes['gen_ai.operation.name'], 'chat');
      assert.equal(span.events[0].attributes?.['exception.type'], 'TypeError');
      assert.ok(!JSON.stringify(span.events).includes('a@b.com'));
    });
  }

  it('classifies every traceroot.* key the SDK writes as content or bookkeeping', () => {
    // A new key must be added here (held back from redact) or to REDACTABLE_KEYS (passed in).
    const bookkeeping = new Set([
      'traceroot.claude_agent_sdk.wrapped',
      'traceroot.environment',
      'traceroot.eval.candidate_version',
      'traceroot.eval.case_id',
      'traceroot.eval.contract_version',
      'traceroot.eval.dataset_id',
      'traceroot.eval.dataset_name',
      'traceroot.eval.dataset_version_id',
      'traceroot.eval.environment',
      'traceroot.eval.has_expected',
      'traceroot.eval.local_run_id',
      'traceroot.eval.name',
      'traceroot.eval.run_id',
      'traceroot.eval.run_name',
      'traceroot.eval.score_target_span_id',
      'traceroot.eval.score_value',
      'traceroot.eval.scorer_name',
      'traceroot.eval.source_span_id',
      'traceroot.eval.source_trace_id',
      'traceroot.eval.task_name',
      'traceroot.git.ref',
      'traceroot.git.repo',
      'traceroot.git.source_file',
      'traceroot.git.source_function',
      'traceroot.git.source_line',
      'traceroot.llm.model',
      'traceroot.llm.usage',
      'traceroot.pi.force_closed',
      'traceroot.pi.force_closed_reason',
      'traceroot.pi.retry_count',
      'traceroot.pi.wrapped',
      'traceroot.project_id',
      'traceroot.redacted',
      'traceroot.sdk.name',
      'traceroot.sdk.version',
      'traceroot.source',
      'traceroot.span.ids_path',
      'traceroot.span.path',
      'traceroot.span.tags',
      'traceroot.span.type',
      'traceroot.trace.tags',
    ]);
    const src = join(__dirname, '..', 'src');
    const written = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) =>
        [
          ...readFileSync(join(src, file), 'utf8').matchAll(
            /(?<!Symbol\.for\()['"`](traceroot\.[\w.]*\w)['"`]/g,
          ),
        ].map((m) => m[1]),
      );
    for (const key of new Set(written)) {
      assert.ok(REDACTABLE_KEYS.has(key) !== bookkeeping.has(key), `classify ${key}`);
    }
  });
});
