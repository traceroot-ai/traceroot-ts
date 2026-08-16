// Emitted-metric ownership manifest at completion. A scorer DEFINITION (grade) owns the METRIC it
// emits (quality). The platform keys a metric's policy on the EMITTED-metric name, so completion
// must carry scorers[].emitted_metrics recording grade->quality with grade's declared policy, or the
// platform can't resolve quality's threshold/direction and defaults it (wrong pass/fail + comparison).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { Dataset, evaluate, scorer } from '../src/eval';
import { _resetForTesting } from '../src/traceroot';
import { _resetSpansState } from '../src/spans';

const realFetch = globalThis.fetch;
let provider: NodeTracerProvider;
beforeEach(() => {
  // Route eval spans to an in-memory exporter so they never reach the network (a set API key would
  // otherwise auto-init the OTLP exporter and reject asynchronously against the mock host).
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

function capture(): Array<{ url: string; body: any }> {
  const calls: Array<{ url: string; body: any }> = [];
  process.env['TRACEROOT_API_KEY'] = 'tr-x';
  globalThis.fetch = (async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/evaluation-runs'))
      return new Response(JSON.stringify({ evaluation_run_id: 'run1' }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  return calls;
}
function ds() {
  const d = new Dataset('d');
  d.datasetId = 'ds_1';
  d.datasetVersionId = 'v1';
  d.upsert({ input: 'i', id: 'c0', expected: 'e' });
  return d;
}
const grade = scorer(
  function grade() {
    return { name: 'quality', value: 0.3 };
  },
  { valueType: 'numeric', direction: 'lower_is_better', threshold: 0.62 },
);
const length = scorer(
  function length() {
    return { name: 'length', value: 1.0 };
  },
  { valueType: 'numeric', direction: 'higher_is_better', threshold: 0.0 },
);

describe('emitted-metric ownership manifest at completion', () => {
  it('records grade->quality (with grade policy) in complete scorers[]', async () => {
    const calls = capture();
    await evaluate({
      name: 'r',
      dataset: ds(),
      task: () => 'out',
      scorers: [grade, length],
    });
    const complete = calls.find((c) => c.url.endsWith('/complete'))!.body;
    const by: Record<string, any> = {};
    for (const s of complete.scorers) by[s.name] = s;
    assert.deepEqual(by.grade.emitted_metrics, [
      { name: 'quality', value_type: 'numeric', direction: 'lower_is_better', threshold: 0.62 },
    ]);
    assert.equal(by.grade.name, 'grade'); // function identity stays separate from metric identity
    assert.deepEqual(by.length.emitted_metrics, [
      { name: 'length', value_type: 'numeric', direction: 'higher_is_better', threshold: 0.0 },
    ]);
  });

  it('single scorer with a name-divergent metric still records grade->quality', async () => {
    const calls = capture();
    await evaluate({ name: 'r', dataset: ds(), task: () => 'out', scorers: [grade] });
    const complete = calls.find((c) => c.url.endsWith('/complete'))!.body;
    const by: Record<string, any> = {};
    for (const s of complete.scorers) by[s.name] = s;
    assert.deepEqual(by.grade.emitted_metrics, [
      { name: 'quality', value_type: 'numeric', direction: 'lower_is_better', threshold: 0.62 },
    ]);
  });
});
