// Scorer naming + binding. A scorer's DECLARED name is its reported identity everywhere: the Score
// it emits, the scorer->metric ownership map, and the registration/completion manifest. When those
// disagree the platform cannot attribute a metric to its definition (emitted_metrics is dropped) nor
// resolve its policy (passed is null). Also: a TS scorer takes one ScorerContext — a positional
// (input, output) signature must fail loudly instead of silently scoring every case wrong.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { Dataset, evaluate, scorer, Scorer, scorerMetadata, describeScorers } from '../src/eval';
import type { ScorerContext } from '../src/eval';
import { _resetForTesting } from '../src/traceroot';
import { _resetSpansState } from '../src/spans';

const realFetch = globalThis.fetch;
let provider: NodeTracerProvider;
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

describe('declared scorer names drive the whole run (TS)', () => {
  it('two Scorer.code({name}, arrow) scorers stay distinct end to end', async () => {
    const calls = capture();
    // The namespace's flagship form: an arrow passed as an argument has fn.name === ''.
    const covers = Scorer.code(
      { name: 'covers', valueType: 'numeric', direction: 'higher_is_better', threshold: 0.5 },
      (_ctx: ScorerContext) => 1,
    );
    const brevity = Scorer.code(
      { name: 'brevity', valueType: 'numeric', direction: 'lower_is_better', threshold: 0.9 },
      (_ctx: ScorerContext) => 0.2,
    );
    const result = await evaluate({
      name: 'r',
      dataset: ds(),
      task: () => 'out',
      scorers: [covers, brevity],
    });

    // 1. each Score carries its declared name (not the 'scorer' fallback, not one merged metric)
    assert.deepEqual(
      result.itemResults[0].scores.map((s) => s.name),
      ['covers', 'brevity'],
    );

    // 2. per-metric `passed` resolves against the declaring scorer's policy
    const scores = calls.find((c) => c.url.endsWith('/results'))!.body.scores;
    const passedBy: Record<string, unknown> = {};
    for (const s of scores) passedBy[s.scorer_name] = s.passed;
    assert.deepEqual(passedBy, { covers: true, brevity: true }); // 1 >= 0.5, 0.2 <= 0.9

    // 3. completion attributes each emitted metric to the definition that produced it
    const complete = calls.find((c) => c.url.endsWith('/complete'))!.body;
    const by: Record<string, any> = {};
    for (const s of complete.scorers) by[s.name] = s;
    assert.deepEqual(by.covers.emitted_metrics, [
      { name: 'covers', value_type: 'numeric', direction: 'higher_is_better', threshold: 0.5 },
    ]);
    assert.deepEqual(by.brevity.emitted_metrics, [
      { name: 'brevity', value_type: 'numeric', direction: 'lower_is_better', threshold: 0.9 },
    ]);
  });

  it('an anonymous scorer never reports an empty key/name', () => {
    // `declared(fn,'name')` finds the built-in Function.prototype.name (''), which must count as
    // absent — otherwise the empty string lands in `key`, the identity field.
    const bare = scorerMetadata(scorer((_ctx: ScorerContext) => 1, { valueType: 'numeric' }));
    assert.equal(bare.name, 'scorer');
    assert.equal(bare.key, 'scorer');
    const keyed = scorerMetadata(scorer((_ctx: ScorerContext) => 1, { key: 'grade' }));
    assert.equal(keyed.key, 'grade');
    assert.notEqual(keyed.name, '');
  });

  it('the value-type hint is keyed by the declared name', () => {
    const covers = Scorer.code({ name: 'covers' }, (_ctx: ScorerContext) => 1);
    // describeScorers hints are keyed by the reported name; an anonymous arrow must not lose its.
    const [desc] = describeScorers([covers], { covers: 'numeric' });
    assert.equal(desc.value_type, 'numeric');
  });
});

describe('TS scorers take a single ScorerContext (TS)', () => {
  it('rejects a positional (input, output) scorer with an actionable error', async () => {
    capture();
    await assert.rejects(
      evaluate({
        name: 'r',
        dataset: ds(),
        task: () => 'out',
        scorers: [((input: unknown, output: unknown) => input === output) as any],
      }),
      /single ScorerContext/,
    );
  });

  it('still accepts the destructured-context form', async () => {
    capture();
    const result = await evaluate({
      name: 'r',
      dataset: ds(),
      task: () => 'e',
      scorers: [({ output, expected }: ScorerContext) => output === expected],
    });
    assert.equal(result.itemResults[0].scores[0].value, true);
  });
});
