// OE-8: trace-native execution parity (Python OE-4): span hierarchy, attributes, isolation.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { _resetSpansState } from '../src/spans';
import { _resetForTesting } from '../src/traceroot';
import { observe, _resetObserveState } from '../src/observe';
import { Dataset, evaluate, evaluateAsync, FakeTransport } from '../src/eval';
import type { ScorerContext } from '../src/eval';

// Cloud-only: every run reports and exports its per-case spans. These structural tests run
// through a non-network FakeTransport (a stand-in cloud transport) so spans are inspectable.
const reported = () => ({ transport: new FakeTransport() });

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

function ds(n: number, extra: Record<string, unknown> = {}): Dataset {
  const d = new Dataset('d');
  for (let i = 0; i < n; i++) d.upsert({ input: i, id: `c${i}`, expected: i, ...extra });
  return d;
}
const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);

function byName(spans: ReadableSpan[]): Record<string, ReadableSpan> {
  return Object.fromEntries(spans.map((s) => [s.name, s]));
}

describe('span hierarchy', () => {
  it('emits evaluation-item -> task + scorer sibling', async () => {
    await evaluate({ name: 'r', data: ds(1), task: echo, scorers: [exact], ...reported() });
    const spans = exporter.getFinishedSpans();
    assert.deepEqual(spans.map((s) => s.name).sort(), ['evaluation-item', 'exact', 'task']);
    const by = byName(spans);
    const rootId = by['evaluation-item'].spanContext().spanId;
    assert.equal(by['evaluation-item'].parentSpanId, undefined);
    assert.equal(by['task'].parentSpanId, rootId);
    assert.equal(by['exact'].parentSpanId, rootId); // sibling of task, under root
  });

  it('user observe() span nests under the task span', async () => {
    const taskWithInner = async (x: unknown) =>
      observe({ name: 'inner_llm', type: 'llm' }, () => x);
    await evaluateAsync({
      name: 'r',
      data: ds(1),
      task: taskWithInner,
      scorers: [exact],
      ...reported(),
    });
    const by = byName(exporter.getFinishedSpans());
    assert.ok(by['inner_llm']);
    assert.equal(by['inner_llm'].parentSpanId, by['task'].spanContext().spanId);
  });
});

describe('concurrency isolation', () => {
  it('5 concurrent cases produce 5 clean traces', async () => {
    await evaluate({
      name: 'r',
      data: ds(5),
      task: echo,
      scorers: [exact],
      maxConcurrency: 5,
      ...reported(),
    });
    const spans = exporter.getFinishedSpans();
    const byTrace = new Map<string, ReadableSpan[]>();
    for (const s of spans) {
      const t = s.spanContext().traceId;
      byTrace.set(t, [...(byTrace.get(t) ?? []), s]);
    }
    assert.equal(byTrace.size, 5);
    for (const traceSpans of byTrace.values()) {
      assert.deepEqual(traceSpans.map((s) => s.name).sort(), ['evaluation-item', 'exact', 'task']);
      const by = byName(traceSpans);
      const rootId = by['evaluation-item'].spanContext().spanId;
      assert.equal(by['task'].parentSpanId, rootId);
      assert.equal(by['exact'].parentSpanId, rootId);
    }
  });
});

describe('eval attributes and trace id', () => {
  it('root/task/scorer attributes', async () => {
    const dataset = ds(1, { metadata: { cat: 'x' }, sourceTraceId: 't1', sourceSpanId: 's1' });
    await evaluate({
      name: 'routing-v2',
      data: dataset,
      task: echo,
      scorers: [exact],
      ...reported(),
    });
    const by = byName(exporter.getFinishedSpans());
    const root = by['evaluation-item'].attributes;
    assert.equal(root['traceroot.span.type'], 'evaluation');
    assert.equal(root['traceroot.eval.run_name'], 'routing-v2');
    assert.equal(root['traceroot.eval.dataset_name'], 'd');
    assert.equal(root['traceroot.eval.case_id'], 'c0');
    assert.equal(root['traceroot.eval.has_expected'], true);
    assert.equal(root['traceroot.eval.source_trace_id'], 't1');
    assert.equal(root['traceroot.eval.source_span_id'], 's1');
    assert.equal(by['task'].attributes['traceroot.eval.task_name'], 'echo');
    assert.equal(by['exact'].attributes['traceroot.eval.scorer_name'], 'exact');
    assert.equal(by['exact'].attributes['traceroot.eval.score_value'], 1);
  });

  it('has_expected false when absent, run_name on all spans', async () => {
    const d = new Dataset('d');
    d.upsert({ input: 1, id: 'c0' });
    await evaluate({ name: 'run-x', data: d, task: echo, scorers: [exact], ...reported() });
    const by = byName(exporter.getFinishedSpans());
    assert.equal(by['evaluation-item'].attributes['traceroot.eval.has_expected'], false);
    for (const n of ['evaluation-item', 'task', 'exact']) {
      assert.equal(by[n].attributes['traceroot.eval.run_name'], 'run-x');
    }
  });

  it('trace id returned per item and matches root (reported run)', async () => {
    // Parity with Python: a result carries a trace id only for a REPORTED run.
    const { FakeTransport } = await import('../src/eval');
    const result = await evaluate({
      name: 'r',
      data: ds(1),
      task: echo,
      scorers: [exact],
      transport: new FakeTransport(),
    });
    const root = byName(exporter.getFinishedSpans())['evaluation-item'];
    assert.equal(result.itemResults[0].traceId, root.spanContext().traceId);
  });

  it('task error marks span and isolates', async () => {
    const boom = (x: number) => {
      if (x === 1) throw new Error('kaboom');
      return x;
    };
    const result = await evaluate({
      name: 'r',
      data: ds(3),
      task: boom,
      scorers: [exact],
      ...reported(),
    });
    const byId = Object.fromEntries(result.itemResults.map((it) => [it.caseId, it]));
    assert.ok(byId.c1.error?.includes('kaboom'));
    assert.equal(byId.c0.error, null);
    const errTasks = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'task' && s.attributes['traceroot.eval.error']);
    assert.ok(
      errTasks.some((s) => String(s.attributes['traceroot.eval.error']).includes('kaboom')),
    );
  });
});

describe('llm judge trace', () => {
  it('the judge emits a nested LLM span (input=prompt, output=response)', async () => {
    const { llmJudge } = await import('../src/eval');
    const judge = llmJudge({
      name: 'conciseness',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'ANSWER:\n{{output}}' }],
      complete: () => '0.8', // deterministic, no network
    });
    const d = new Dataset('d');
    d.upsert({ input: 0, id: 'c0', expected: 0 });
    await evaluate({ name: 'r', dataset: d, task: echo, scorers: [judge], ...reported() });

    const by = byName(exporter.getFinishedSpans());
    const llm = by['llm_judge:conciseness'];
    const scorer = by['conciseness']; // scorer span named by the judge
    assert.ok(llm, 'expected a nested llm_judge span');
    assert.equal(llm.parentSpanId, scorer.spanContext().spanId); // nested under the scorer
    assert.match(String(llm.attributes['input.value']), /ANSWER/); // rendered prompt in
    assert.match(String(llm.attributes['output.value']), /0\.8/); // model response out
  });

  it('skips its own LLM span when a provider integration already traces the model', async () => {
    const { llmJudge } = await import('../src/eval');
    const { __setInstrumentedProvidersForTest } = await import('../src/instrumentation');
    __setInstrumentedProvidersForTest(['anthropic']); // simulate an active anthropic integration
    try {
      const judge = llmJudge({
        name: 'conciseness',
        model: 'claude-sonnet-5', // anthropic model -> checks the anthropic integration
        messages: [{ role: 'user', content: 'ANSWER:\n{{output}}' }],
        complete: () => '0.8',
      });
      const d = new Dataset('d');
      d.upsert({ input: 0, id: 'c0', expected: 0 });
      const result = await evaluate({
        name: 'r',
        dataset: d,
        task: echo,
        scorers: [judge],
        ...reported(),
      });
      const by = byName(exporter.getFinishedSpans());
      assert.equal(by['llm_judge:conciseness'], undefined); // integration owns the LLM span, not us
      assert.ok(by['conciseness']); // the scorer span still exists
      assert.equal(result.itemResults[0].scores[0].value, 0.8); // judge still ran + scored
    } finally {
      __setInstrumentedProvidersForTest([]); // reset for other tests
    }
  });
});
