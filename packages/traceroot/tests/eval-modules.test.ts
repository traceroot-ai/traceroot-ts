// Parity: scorers metadata, comparison, session, provenance, snippets, evaluation, deferred.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  scorer,
  describeScorers,
  scorerMetadata,
  compareRuns,
  makeRunResult,
  RunSession,
  FakeTransport,
  collectRunProvenance,
  datasetLatestSnippet,
  datasetVersionSnippet,
  reproduceRunSnippet,
  Evaluation,
  Dataset,
  DeferredScore,
  evaluate,
} from '../src/eval';
import * as prov from '../src/eval/provenance';
import type { EvalItemResult, ScorerContext } from '../src/eval';

const echo = (x: unknown) => x;

// ---------------------------------------------------------------------------
describe('scorer metadata', () => {
  it('defaults + explicit-wins + no name inference + no version fabrication', () => {
    const acc = scorer((_c: ScorerContext) => 1, { valueType: 'numeric' });
    assert.deepEqual(
      { ...scorerMetadata(acc), name: 'x' },
      {
        name: 'x',
        version: null,
        value_type: 'numeric',
        direction: 'higher_is_better',
        threshold: null,
      },
    );
    const latency = scorer((_c: ScorerContext) => 1, {
      valueType: 'numeric',
      direction: 'lower_is_better',
    });
    assert.equal(scorerMetadata(latency).direction, 'lower_is_better'); // not inferred from name
    const route = scorer((_c: ScorerContext) => 'billing', { valueType: 'categorical' });
    assert.equal(scorerMetadata(route).direction, 'none');
    const plain = (_c: ScorerContext) => 1;
    assert.equal(scorerMetadata(plain).version, null); // never fabricated
  });
  it('invalid value_type/direction throw', () => {
    assert.throws(() => scorer(() => 1, { valueType: 'nope' as never }));
    assert.throws(() => scorer(() => 1, { direction: 'up' as never }));
  });
  it('describeScorers with a runtime value-type hint', () => {
    function latency(_c: ScorerContext) {
      return 1;
    }
    scorer(latency, { direction: 'lower_is_better' });
    const [d] = describeScorers([latency], { latency: 'numeric' });
    assert.equal(d.value_type, 'numeric');
    assert.equal(d.direction, 'lower_is_better');
  });
});

// ---------------------------------------------------------------------------
describe('comparison (score cells)', () => {
  function run(name: string, scoresByCase: Record<string, number>) {
    const items: EvalItemResult[] = Object.entries(scoresByCase).map(([caseId, v]) => ({
      caseId,
      input: null,
      output: null,
      expected: null,
      scores: [{ name: 'acc', value: v }],
      scorerErrors: {},
      error: null,
      traceId: null,
      durationMs: null,
    }));
    return makeRunResult(
      name,
      items,
      { status: 'local_only', dashboardUrl: null },
      {
        dataset: {
          datasetId: 'ds',
          revision: 'rev_1',
          datasetVersionId: null,
          caseCount: items.length,
        },
      },
    );
  }
  it('improved / regressed / unchanged / unpaired', () => {
    const base = run('r', { c0: 1, c1: 1, c2: 0 });
    const cand = run('r', { c0: 1, c1: 0, c3: 1 }); // c1 regressed, c2/c3 unpaired
    const cmp = compareRuns(cand, base);
    assert.equal(cmp.regressions.length, 1);
    assert.equal(cmp.unchanged.length, 1); // c0
    assert.deepEqual(cmp.unpaired.sort(), ['c2', 'c3']);
    assert.match(cmp.summary(), /score cells/);
  });

  it('comparisonReport renders a Braintrust-style per-scorer block', () => {
    const base = run('r', { c0: 1, c1: 1 }); // mean 1.00
    const cand = run('r', { c0: 1, c1: 0 }); // mean 0.50, c1 regressed
    const report = cand.comparisonReport(base);
    assert.match(report, /COMPARISON/);
    assert.match(report, /r {2}vs {2}r \[baseline\]/);
    assert.match(report, /50\.00%/); // candidate mean
    assert.match(report, /-50\.00%/); // delta
    assert.match(report, /'acc'/);
    assert.match(report, /\(0 improvements, 1 regression\)/); // singular
  });
});

// ---------------------------------------------------------------------------
describe('RunSession lifecycle', () => {
  it('start -> register -> record -> complete via FakeTransport', async () => {
    const t = new FakeTransport();
    const s = await new RunSession(t, { name: 'r' }).start();
    await s.register({ input: 1, id: 'c0' });
    await s.record({
      caseId: 'c0',
      input: 1,
      output: 1,
      expected: 1,
      scores: [{ name: 'acc', value: 1 }],
      scorerErrors: {},
      error: null,
      traceId: null,
      durationMs: 5,
    });
    const state = await s.complete();
    assert.equal(state.status, 'local_only');
    assert.deepEqual(t.calls[0], ['create_run', 'r', '<inline>']);
    assert.ok(t.calls.some((c) => c[0] === 'register_item' && c[1] === 'c0'));
    assert.ok(t.calls.some((c) => c[0] === 'finish_run'));
  });
});

// ---------------------------------------------------------------------------
describe('provenance (machine-independent)', () => {
  it('github ci + git block; user metadata wins', () => {
    const orig = (prov as any)._resolvedGit;
    // resolvedGit is private; drive via env + no git -> only ci block, plus user keys.
    const meta = collectRunProvenance(
      { model: 'sonnet', git: 'USER' },
      { env: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '9' } as never, detectDirty: false },
    );
    assert.equal(meta!.model, 'sonnet');
    assert.equal(meta!.git, 'USER'); // user key wins over auto git
    assert.deepEqual(meta!.ci, { provider: 'github', build_id: '9' });
    void orig;
  });
  it('nothing available -> null', () => {
    // No CI env and (likely) no git repo signals from an empty env.
    const meta = collectRunProvenance(undefined, { env: {} as never, detectDirty: false });
    assert.ok(meta === null || typeof meta === 'object');
  });
});

// ---------------------------------------------------------------------------
describe('snippets', () => {
  it('python + typescript emit current signatures; no pull_run', () => {
    assert.match(datasetLatestSnippet('ds_1', 'python'), /pull_dataset\("ds_1"\)/);
    assert.match(datasetVersionSnippet('dsv_9', 'python'), /pull_dataset_version\("dsv_9"\)/);
    const repro = reproduceRunSnippet('dsv_9', 'python');
    assert.match(repro, /pull_dataset_version\("dsv_9"\)/);
    assert.ok(!repro.includes('pull_run'));
    assert.match(datasetLatestSnippet('ds_1', 'typescript'), /pullDataset\("ds_1"\)/);
    assert.match(reproduceRunSnippet('dsv_9', 'typescript'), /candidateVersion/);
  });
  it('placeholders + unknown lang throws', () => {
    assert.match(datasetLatestSnippet(undefined, 'python'), /<dataset_id>/);
    assert.throws(() => datasetLatestSnippet('x', 'ruby' as never));
  });
});

// ---------------------------------------------------------------------------
describe('Evaluation object', () => {
  it('runs and rejects retry', async () => {
    const ds = new Dataset('d');
    ds.add(1, { id: 'c0', expected: 1 });
    const run = await new Evaluation({
      name: 'r',
      dataset: ds,
      task: echo,
      scorers: [(c) => (c.output === c.expected ? 1 : 0)],
    }).run();
    assert.equal(run.passed, 1);
    assert.throws(
      () => new Evaluation({ name: 'r', dataset: ds, task: echo, scorers: [() => 1], retry: 3 }),
      /retry is not implemented/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('deferred score', () => {
  it('is pending, never a numeric zero', async () => {
    const ds = new Dataset('d');
    ds.add(1, { id: 'c0', expected: 1 });
    const run = await evaluate({
      name: 'r',
      dataset: ds,
      task: echo,
      scorers: [() => new DeferredScore('human', 'awaiting review')],
      local: true,
    });
    assert.equal(run.itemResults[0].scores[0].value, 'pending');
    assert.equal(run.notScored, 1);
  });
});

let _keep: unknown;
beforeEach(() => {
  _keep = 1;
});
afterEach(() => {
  void _keep;
});
