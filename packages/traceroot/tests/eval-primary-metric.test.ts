// Phase 2 — primary-metric behavior (TS). Recording multiple metrics does not require a primary;
// when none is selected the run completes with every score stored and no invented pass/fail. A
// numeric metric with no declared threshold is scored but carries no fabricated pass/fail.
// `primaryMetric` aliases `mainScore`.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { Dataset, evaluate, scorer, caseStatus, FakeTransport } from '../src/eval';
import type { ScorerContext } from '../src/eval';
import { _resetForTesting } from '../src/traceroot';
import { _resetSpansState } from '../src/spans';

let provider: NodeTracerProvider;
const realFetch = globalThis.fetch;
beforeEach(() => {
  provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()));
  provider.register();
});
afterEach(async () => {
  await provider.shutdown();
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_API_KEY'];
  _resetForTesting();
  _resetSpansState();
});

function ds() {
  const d = new Dataset('d');
  d.upsert({ input: { q: 'hi' }, id: 'c0', expected: 'hi' });
  return d;
}
const twoMetrics = (_ctx: ScorerContext) => ({ accuracy: 1.0, coverage: 0.5 });

describe('primary metric is optional (TS)', () => {
  it('multiple metrics without a primary completes and stores all', async () => {
    const run = await evaluate({
      name: 'r',
      dataset: ds(),
      task: () => 'hi',
      scorers: [twoMetrics],
      transport: new FakeTransport(),
    });
    const scores = Object.fromEntries(run.itemResults[0].scores.map((s) => [s.name, s.value]));
    assert.deepEqual(scores, { accuracy: 1.0, coverage: 0.5 });
    assert.equal(caseStatus(run.itemResults[0], run.mainScore), 'not_scored'); // no invented verdict
  });

  it('primaryMetric aliases mainScore', async () => {
    const run = await evaluate({
      name: 'r',
      dataset: ds(),
      task: () => 'hi',
      scorers: [twoMetrics],
      primaryMetric: 'accuracy',
      transport: new FakeTransport(),
    });
    assert.equal(run.mainScore.name, 'accuracy');
  });

  it('numeric metric with no declared threshold is scored but has no fabricated pass/fail', async () => {
    const calls: any[] = [];
    process.env['TRACEROOT_API_KEY'] = 'tr-x';
    globalThis.fetch = (async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/evaluation-runs'))
        return new Response(JSON.stringify({ evaluation_run_id: 'run1' }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as any;
    const unbounded = scorer((_ctx: ScorerContext) => ({ name: 'quality', value: 0.3 }), {
      valueType: 'numeric', // NO threshold declared
    });
    const d = new Dataset('d');
    d.datasetId = 'ds_1';
    d.datasetVersionId = 'v1';
    d.upsert({ input: 'i', id: 'c0', expected: 'e' });
    await evaluate({ name: 'r', dataset: d, task: () => 'o', scorers: [unbounded] });
    const results = calls.find((c) => c.url.endsWith('/results'))!.body;
    assert.equal(results.scores[0].numeric_value, 0.3); // scored
    assert.equal('passed' in results.scores[0], false); // no fabricated pass/fail
  });
});
