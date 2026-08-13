// Parity: pull (native JSON, exact version, mismatch, 404), upload-by-default decision,
// and PlatformTransport wire payloads — with fetch mocked (no real network).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  Dataset,
  evaluate,
  makeRunResult,
  pullDataset,
  pullDatasetVersion,
  scorer,
  Scorer,
  EvalRunResult,
} from '../src/eval';
import type { ScorerContext } from '../src/eval';
import { PlatformTransport } from '../src/eval/platform';

const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);

type Call = { method: string; url: string; body: any };
let calls: Call[];
const realFetch = globalThis.fetch;

/** Install a fetch that routes GET dataset-version/dataset endpoints from `versions`
 *  and records every POST. Returns nothing; inspect `calls`. */
function mockBackend(
  opts: {
    current?: string;
    versions?: Record<string, any>;
    apiKey?: string;
    runPath?: string;
    runUrl?: string;
  } = {},
) {
  const versions = opts.versions ?? {};
  process.env['TRACEROOT_API_KEY'] = opts.apiKey ?? 'tr-test';
  process.env['TRACEROOT_HOST_URL'] = 'https://h';
  // Keep credentials (for the reporting transport) but suppress OTLP span export, which
  // would otherwise dial the fake host. Mirrors the Python `enabled=False` ambient-creds tests.
  process.env['TRACEROOT_ENABLED'] = 'false';
  globalThis.fetch = (async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const u = String(url);
    if (u.includes('/dataset-versions/')) {
      const vid = u.split('/').pop() as string;
      if (!(vid in versions)) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(versions[vid]), { status: 200 });
    }
    if (u.match(/\/datasets\/[^/]+$/)) {
      return new Response(
        JSON.stringify({ name: 'test', current_dataset_version_id: opts.current }),
        { status: 200 },
      );
    }
    if (u.endsWith('/evaluation-runs')) {
      const resp: Record<string, unknown> = { evaluation_run_id: 'run_1' };
      if (opts.runPath) resp.run_path = opts.runPath;
      if (opts.runUrl) resp.run_url = opts.runUrl;
      return new Response(JSON.stringify(resp), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 }); // results/complete
  }) as any;
}

function version(vid: string, datasetId: string, n = 1) {
  return {
    dataset_id: datasetId,
    dataset_version_id: vid,
    items: Array.from({ length: n }, (_, i) => ({
      test_case_id: `c${i}`,
      input: { i },
      expected: { i },
    })),
  };
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_HOST_URL'];
  delete process.env['TRACEROOT_ENABLED'];
});

describe('pull', () => {
  it('pulls current version and takes native values verbatim', async () => {
    mockBackend({
      current: 'dsv_cur',
      versions: {
        dsv_cur: {
          dataset_id: 'ds_1',
          dataset_version_id: 'dsv_cur',
          items: [
            { test_case_id: 'd', input: { message: 'hi' }, expected: { r: 1 } },
            { test_case_id: 's', input: '{"looks":"like json"}', expected: '42' },
          ],
        },
      },
    });
    const ds = await pullDataset('ds_1');
    assert.equal(ds.datasetId, 'ds_1');
    assert.equal(ds.datasetVersionId, 'dsv_cur');
    assert.deepEqual(ds.get('d')!.input, { message: 'hi' }); // dict stays a dict
    assert.equal(ds.get('s')!.input, '{"looks":"like json"}'); // json-looking string stays a string
    assert.equal(ds.get('s')!.expected, '42'); // "42" stays a string
  });

  it('pulls an exact version and never fetches current', async () => {
    mockBackend({ current: 'dsv_cur', versions: { dsv_old: version('dsv_old', 'ds_1', 3) } });
    const ds = await pullDatasetVersion('dsv_old', { datasetId: 'ds_1' });
    assert.equal(ds.datasetVersionId, 'dsv_old');
    assert.equal(ds.size, 3);
    assert.ok(!calls.some((c) => c.url.endsWith('/dataset-versions/dsv_cur')));
  });

  it('missing version raises a clear error', async () => {
    mockBackend({ versions: {} });
    await assert.rejects(() => pullDatasetVersion('dsv_missing'), /not found/);
  });

  it('pulling a dataset with no current version raises a clear error, not an obscure one', async () => {
    // No `current` => current_dataset_version_id is absent; without the guard a null version id
    // reaches pullDatasetVersion and fails obscurely instead of naming the real problem.
    mockBackend({ versions: {} });
    await assert.rejects(() => pullDataset('ds_1'), /no published version to pull/);
  });

  it('mismatched dataset/version identity raises', async () => {
    mockBackend({ versions: { dsv_x: version('dsv_x', 'ds_OTHER') } });
    await assert.rejects(
      () => pullDatasetVersion('dsv_x', { datasetId: 'ds_1' }),
      /belongs to dataset/,
    );
  });
});

describe('scorer policy is retained for re-upload (M3)', () => {
  it('evaluate captures the declared scorer policy on the result', async () => {
    const acc = scorer((_ctx: ScorerContext) => 1, {
      name: 'acc',
      valueType: 'numeric',
      direction: 'higher_is_better',
      threshold: 0.8,
    });
    const d = new Dataset('m3');
    d.add(1, { id: 'c0', expected: 1 });
    // Captured even for a local run (no transport) — the "run now, upload later" flow.
    const run = await evaluate({ name: 'r', dataset: d, task: echo, scorers: [acc], local: true });
    const spec = (run.scorerSpecs ?? []).find((s) => s.name === 'acc');
    assert.equal(spec?.threshold, 0.8);
    assert.equal(spec?.direction, 'higher_is_better');
  });

  it('scorerSpecs round-trips through toJSON/fromJSON', () => {
    const specs = [
      {
        name: 'acc',
        version: null,
        value_type: 'numeric',
        direction: 'higher_is_better',
        threshold: 0.8,
      },
    ];
    const run = makeRunResult(
      'r',
      [],
      { status: 'uploaded', dashboardUrl: null },
      {
        scorerSpecs: specs,
      },
    );
    const loaded = EvalRunResult.fromJSON(JSON.parse(JSON.stringify(run.toJSON())));
    assert.deepEqual(loaded.scorerSpecs, specs);
  });
});

describe('non-finite scores do not poison the local aggregate', () => {
  it('a NaN score is excluded from the mean instead of folding into it', async () => {
    // H1 errors a non-finite score on the wire; the local aggregate must agree, or run.json and
    // .summary() disagree with the platform (and Python writes a bare NaN while TS writes null).
    const bad = scorer((_ctx: ScorerContext) => NaN, {
      name: 'm',
      valueType: 'numeric',
      threshold: 0.5,
    });
    const d = new Dataset('nan-agg');
    d.add(1, { id: 'c0', expected: 1 });
    const run = await evaluate({ name: 'r', dataset: d, task: echo, scorers: [bad], local: true });
    const m = Object.values(run.scoreSummary)[0];
    assert.equal(m.mean, null); // excluded from the mean, not NaN-folded
    assert.ok(!Number.isNaN(m.mean)); // and specifically not a NaN mean
    assert.equal(m.count, 1); // still counts as a produced score
    // The serialized artifact is valid JSON that round-trips (JS stringify never emits a bare NaN).
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(run.toJSON())));
  });
});

describe('summary() shows per-metric pass-rate', () => {
  it('includes pass=k/n for a scorer with a declared threshold', async () => {
    const hit = scorer((ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0), {
      name: 'hit',
      valueType: 'numeric',
      direction: 'higher_is_better',
      threshold: 1.0,
    });
    const d = new Dataset('passrate');
    d.add(1, { id: 'a', expected: 1 }); // pass
    d.add(0, { id: 'b', expected: 1 }); // fail
    const run = await evaluate({ name: 'r', dataset: d, task: echo, scorers: [hit], local: true });
    const line = run
      .summary()
      .split('\n')
      .find((l) => l.trim().startsWith('hit'))!;
    assert.ok(line.includes('pass=1/2'), line); // one of two cleared the threshold
    assert.ok(line.includes('count=2'));
  });

  it('resolves pass-rate name-agnostically for a lone single-emission scorer', async () => {
    // The scorer's declared name differs from the emitted score name; the lone scorer still owns
    // its lone metric (same rule as PlatformTransport), so the pass-rate resolves.
    const s = Scorer.code(
      { key: 'x', valueType: 'numeric', direction: 'higher_is_better', threshold: 1.0 },
      () => ({ name: 'differently_named', value: 1.0 }),
    );
    const d = new Dataset('agnostic');
    d.add(1, { id: 'a', expected: 1 });
    const run = await evaluate({ name: 'r', dataset: d, task: echo, scorers: [s], local: true });
    const line = run
      .summary()
      .split('\n')
      .find((l) => l.includes('mean='))!;
    assert.ok(line.includes('pass=1/1'), line);
  });

  it('omits pass= when no threshold is declared', async () => {
    const plain = (_ctx: ScorerContext) => 0.5; // no declared policy -> nothing to judge
    const d = new Dataset('nopolicy');
    d.add(1, { id: 'a', expected: 1 });
    const run = await evaluate({
      name: 'r',
      dataset: d,
      task: echo,
      scorers: [plain],
      local: true,
    });
    const line = run
      .summary()
      .split('\n')
      .find((l) => l.includes('mean='))!;
    assert.ok(!line.includes('pass='), line); // no fabricated verdict
  });
});

describe('reporting (cloud-only)', () => {
  it('no credentials -> throws (nothing to report to)', async () => {
    // no api key set -> resolveCredentials empty -> no reporting transport -> cloud-only raise
    const ds = new Dataset('d');
    ds.datasetId = 'ds_1';
    ds.datasetVersionId = 'dsv_1';
    ds.upsert({ input: 1, id: 'c0', expected: 1 });
    await assert.rejects(
      evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] }),
      /reports to the TraceRoot platform/,
    );
  });

  it('remote dataset + creds -> uploaded by default, with correct payloads', async () => {
    mockBackend({});
    const ds = new Dataset('d');
    ds.datasetId = 'ds_1';
    ds.datasetVersionId = 'dsv_1';
    ds.upsert({ input: 1, id: 'c0', expected: 1 });
    const result = await evaluate({
      name: 'r',
      dataset: ds,
      task: echo,
      scorers: [exact],
      candidateVersion: 'v1',
    });
    assert.equal(result.uploadState.status, 'uploaded');
    assert.equal(result.runId, 'run_1');

    const reg = calls.find((c) => c.url.endsWith('/evaluation-runs'))!;
    assert.equal(reg.body.candidate_version, 'v1');
    assert.equal(reg.body.dataset_version_id, 'dsv_1');
    const sc = reg.body.scorers[0];
    assert.equal(sc.name, 'exact');
    assert.equal(sc.version, 'unversioned');
    assert.equal(sc.scorer_type, 'code'); // definition rides the manifest
    assert.equal(sc.language, 'typescript');
    assert.ok(typeof sc.source === 'string' && sc.source.length > 0);

    const res = calls.find((c) => c.url.endsWith('/results'))!;
    // No headline pass/fail: an error-free case reports not_scored, and no main_score rides the wire.
    assert.equal(res.body.status, 'not_scored');
    assert.equal('main_score' in res.body, false);
    assert.equal(typeof res.body.duration_ms, 'number');

    const done = calls.find((c) => c.url.endsWith('/complete'))!;
    assert.equal('main_score' in done.body, false);
    assert.equal('main_score_name' in done.body, false);
  });

  it('a snapshot of a synced dataset reports exactly like the dataset', async () => {
    // Parity with Python's _auto_transport: a DatasetSnapshot carrying baseVersionId is a synced
    // dataset, so `evaluate(dataset.snapshot())` reports instead of failing "no synced dataset".
    mockBackend({});
    const ds = new Dataset('d');
    ds.datasetId = 'ds_1';
    ds.datasetVersionId = 'dsv_1';
    ds.baseVersionId = 'dsv_1'; // pushed/pulled: the snapshot inherits the pinned version
    ds.upsert({ input: 1, id: 'c0', expected: 1 });
    const snap = ds.snapshot();

    const result = await evaluate({ name: 'r', dataset: snap, task: echo, scorers: [exact] });

    assert.equal(result.uploadState.status, 'uploaded');
    assert.equal(result.runId, 'run_1');
    const reg = calls.find((c) => c.url.endsWith('/evaluation-runs'))!;
    assert.equal(reg.body.dataset_version_id, 'dsv_1');
    assert.equal(reg.body.dataset_id, 'ds_1'); // reported against the snapshot's dataset
    assert.ok(calls.some((c) => c.url.endsWith('/complete')));
    assert.equal(result.dataset.revision, snap.revision);
    assert.equal(result.dataset.datasetVersionId, 'dsv_1');
  });

  it('a snapshot with no version id is unsynced -> no upload', async () => {
    // Negative guard, also Python parity: a locally-authored dataset's snapshot carries no
    // baseVersionId, so it stays unsynced (no auto-provision for a snapshot) and the run raises
    // the "no synced dataset" cause rather than uploading.
    mockBackend({});
    const ds = new Dataset('local');
    ds.add(1, { expected: 1 });
    await assert.rejects(
      () => evaluate({ name: 'r', dataset: ds.snapshot(), task: echo, scorers: [exact] }),
      /synced dataset/,
    );
    assert.equal(
      calls.some((c) => c.url.endsWith('/evaluation-runs') || c.url.endsWith('/versions')),
      false,
    );
  });

  it('never sends a baseline_run_id (comparison is the backend’s job)', async () => {
    mockBackend({});
    const ds = new Dataset('d');
    ds.datasetId = 'ds_1';
    ds.datasetVersionId = 'dsv_1';
    ds.upsert({ input: 1, id: 'c0', expected: 1 });
    await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });
    const reg = calls.find((c) => c.url.endsWith('/evaluation-runs'))!;
    assert.equal('baseline_run_id' in reg.body, false);
  });

  it('case status is errored (task error) | errored (scorer error) | not_scored', async () => {
    // Per-case status carries no headline pass/fail: it is errored when the case had a task error
    // OR any scorer error, otherwise not_scored. main_score never rides the per-case wire.
    mockBackend({});
    const t = new PlatformTransport('ds_1', { scorerNames: ['grade'] });
    const run = await t.createRun('r', 'd', null);
    const base = { caseId: 'c', input: 'i', output: 'o', expected: 'e', traceId: 't' };
    // scored, no error -> not_scored
    await t.recordItemResult(run, {
      ...base,
      caseId: 'c0',
      scores: [{ name: 'quality', value: 0.3 }],
      scorerErrors: {},
      error: null,
    });
    // task error -> errored
    await t.recordItemResult(run, {
      ...base,
      caseId: 'c1',
      scores: [],
      scorerErrors: {},
      error: 'boom',
    });
    // scorer error (no task error) -> errored
    await t.recordItemResult(run, {
      ...base,
      caseId: 'c2',
      scores: [],
      scorerErrors: { grade: 'kaboom' },
      error: null,
    });
    await t.finishRun(run, null);
    const results = calls.filter((c) => c.url.endsWith('/results')).map((c) => c.body);
    assert.deepEqual(
      results.map((b) => b.status),
      ['not_scored', 'errored', 'errored'],
    );
    for (const b of results) assert.equal('main_score' in b, false);
    // Completion counts: one task error, one scorer error. scored_count is a COMPLETENESS
    // count (cases that produced a score with no task error), not a pass/fail rollup — only
    // c0 qualifies. Python parity: test_platform.py::test_finish_run_sends_counts_and_no_main_score.
    const done = calls.find((c) => c.url.endsWith('/complete'))!.body;
    assert.equal(done.task_error_count, 1);
    assert.equal(done.scorer_error_count, 1);
    assert.equal(done.scored_count, 1);
    assert.equal('main_score' in done, false);
  });

  it('completion counts survive a replayed case (keyed by test_case_id)', async () => {
    // scored_count rides the same per-case contribution map as the error totals, so a retried
    // case (or a second upload() on the same transport) REPLACES its contribution.
    mockBackend({});
    const t = new PlatformTransport('ds_1', { scorerNames: ['grade'] });
    const run = await t.createRun('r', 'd', null);
    const base = { caseId: 'c0', input: 'i', output: 'o', expected: 'e', traceId: 't' };
    const scored = {
      ...base,
      scores: [{ name: 'quality', value: 1 }],
      scorerErrors: {},
      error: null,
    };
    await t.recordItemResult(run, scored);
    await t.recordItemResult(run, scored); // replay
    await t.finishRun(run, null);
    const done = calls.find((c) => c.url.endsWith('/complete'))!.body;
    assert.equal(done.scored_count, 1);
  });

  it('sends per-score passed for a single scorer, name-agnostically', async () => {
    // Each emitted score carries an SDK-computed `passed` (contract ScoreInput.passed) so the
    // platform never re-derives policy. A single scorer 'grade' emitting {name:'quality', 0.3}
    // under lower_is_better threshold 0.2 -> 0.3 <= 0.2 is false -> passed false, consistent with
    // the case status 'failed'. The emitted name stays the score identity.
    mockBackend({});
    const t = new PlatformTransport('ds_1', {});
    t.scorerSpecs = [{ name: 'grade', threshold: 0.2, direction: 'lower_is_better' }];
    const run = await t.createRun('r', 'd', null);
    await t.recordItemResult(run, {
      caseId: 'c1',
      input: 'i',
      output: 'o',
      expected: 'e',
      scores: [{ name: 'quality', value: 0.3 }],
      scorerErrors: {},
      error: null,
      traceId: 't',
    });
    const res = calls.find((c) => c.url.endsWith('/results'))!;
    assert.equal(res.body.scores[0].scorer_name, 'quality');
    assert.equal(res.body.scores[0].passed, false);
  });

  it('per-score passed is honest per value type and per owning policy', async () => {
    // Boolean: true = pass. Categorical: no pass/fail -> omitted. With multiple scorers each
    // numeric score is judged by the scorer whose declared name matches the emitted metric; a
    // numeric metric matching no declared scorer is left unresolved (omitted, never guessed).
    mockBackend({});
    const t = new PlatformTransport('ds_1', {});
    t.scorerSpecs = [
      { name: 'accuracy', threshold: 1.0, direction: 'higher_is_better' },
      { name: 'is_billing' },
      { name: 'route' },
    ];
    const run = await t.createRun('r', 'd', null);
    await t.recordItemResult(run, {
      caseId: 'c1',
      input: 'i',
      output: 'o',
      expected: 'e',
      scores: [
        { name: 'accuracy', value: 1.0 }, // 1 >= 1 -> passed true
        { name: 'is_billing', value: true }, // boolean true -> passed true
        { name: 'route', value: 'billing' }, // categorical -> omitted
        { name: 'mystery', value: 0.5 }, // numeric, matches no scorer -> omitted
      ],
      scorerErrors: {},
      error: null,
      traceId: 't',
    });
    const res = calls.find((c) => c.url.endsWith('/results'))!;
    const byName: Record<string, Record<string, unknown>> = {};
    for (const s of res.body.scores as Record<string, unknown>[])
      byName[s.scorer_name as string] = s;
    assert.equal(byName.accuracy.passed, true);
    assert.equal(byName.is_billing.passed, true);
    assert.equal('passed' in byName.route, false);
    assert.equal('passed' in byName.mystery, false);
  });

  it('lower_is_better is inclusive at the threshold', async () => {
    // Both directions are INCLUSIVE at the threshold: `latency_ms <= 200` passes at exactly 200
    // and fails at 200.1, mirroring higher_is_better's `1 >= 1` above. A budget stated as "at most
    // 200ms" is met by a 200ms answer — an exclusive boundary would fail it. Parity with
    // traceroot-py test_platform test_lower_is_better_threshold_is_inclusive.
    mockBackend({});
    const t = new PlatformTransport('ds_1', {});
    t.scorerSpecs = [{ name: 'latency_ms', threshold: 200, direction: 'lower_is_better' }];
    const run = await t.createRun('r', 'd', null);
    for (const value of [200, 200.1, 199.9]) {
      await t.recordItemResult(run, {
        caseId: `c-${value}`,
        input: 'i',
        output: 'o',
        expected: 'e',
        scores: [{ name: 'latency_ms', value }],
        scorerErrors: {},
        error: null,
        traceId: 't',
      });
    }
    const sent = calls
      .filter((c) => c.url.endsWith('/results'))
      .map((c) => (c.body.scores as Record<string, unknown>[])[0].passed);
    assert.deepEqual(sent, [true, false, true]);
  });
});

describe('run URL (run_url preferred, run_path fallback -> dashboardUrl)', () => {
  it('joins host + run_path into dashboardUrl', async () => {
    mockBackend({ runPath: '/projects/proj_9/evaluations/run_1' });
    const ds = new Dataset('d');
    ds.add({ i: 0 }, { expected: { i: 0 } });
    const run = await evaluate({
      name: 'r',
      dataset: ds,
      task: echo,
      scorers: [exact],
      transport: new PlatformTransport('ds_1'),
    });
    // host is whatever resolveCredentials returns; the point is host + run_path joined.
    const url = run.uploadState.dashboardUrl!;
    assert.match(url, /^https?:\/\/.+\/projects\/proj_9\/evaluations\/run_1$/);
  });

  it('prefers an absolute run_url over host + run_path (split origins)', async () => {
    // API host on :8000, run_url resolved against the UI origin on :3000.
    mockBackend({
      runPath: '/projects/proj_9/evaluations/run_1',
      runUrl: 'http://localhost:3000/projects/proj_9/evaluations/run_1',
    });
    const ds = new Dataset('d');
    ds.add({ i: 0 }, { expected: { i: 0 } });
    const run = await evaluate({
      name: 'r',
      dataset: ds,
      task: echo,
      scorers: [exact],
      transport: new PlatformTransport('ds_1'),
    });
    // run_url wins verbatim; the API origin is never used to build the link.
    assert.equal(
      run.uploadState.dashboardUrl,
      'http://localhost:3000/projects/proj_9/evaluations/run_1',
    );
  });

  it('leaves dashboardUrl null when the backend omits run_path', async () => {
    mockBackend();
    const ds = new Dataset('d');
    ds.add({ i: 0 }, { expected: { i: 0 } });
    const run = await evaluate({
      name: 'r',
      dataset: ds,
      task: echo,
      scorers: [exact],
      transport: new PlatformTransport('ds_1'),
    });
    assert.equal(run.uploadState.dashboardUrl, null);
    assert.equal(run.uploadState.status, 'uploaded');
  });
});

describe('re-upload scorer registration', () => {
  it('registers a scorer that errored on every case (absent from the score summary)', async () => {
    // Python parity (results.py upload()): the transport built for a re-upload unions the score
    // summary with every scorer NAME seen on the items — scores AND scorer errors. Registering
    // only Object.keys(scoreSummary) silently drops an all-failing scorer from the run.
    mockBackend({});
    const run = makeRunResult(
      'r',
      [
        {
          caseId: 'c0',
          input: 'i',
          output: 'o',
          expected: 'e',
          scores: [{ name: 'acc', value: 1 }],
          scorerErrors: { flaky: 'boom' },
          error: null,
          traceId: null,
          durationMs: null,
        },
      ],
      { status: 'uploaded', dashboardUrl: null },
      {
        localRunId: 'run_local_1',
        dataset: { datasetId: 'ds_1', revision: 'rev_x', datasetVersionId: 'dsv_1', caseCount: 1 },
      },
    );
    await run.upload();
    const reg = calls.find((c) => c.url.endsWith('/evaluation-runs'))!;
    const names = (reg.body.scorers as Array<{ name: string }>).map((s) => s.name);
    assert.deepEqual(names, ['acc', 'flaky']);
  });
});

describe('re-upload with an explicit transport', () => {
  const specs = [
    {
      name: 'acc',
      version: 'v1',
      value_type: 'numeric',
      direction: 'higher_is_better',
      threshold: 0.8,
    },
  ];

  function retainedRun(): EvalRunResult {
    return makeRunResult(
      'r',
      [
        {
          caseId: 'c0',
          input: 'i',
          output: 'o',
          expected: 'e',
          scores: [{ name: 'acc', value: 0.9 }],
          scorerErrors: {},
          error: null,
          traceId: null,
          durationMs: null,
        },
      ],
      { status: 'uploaded', dashboardUrl: null },
      {
        localRunId: 'run_local_specs',
        dataset: { datasetId: 'ds_1', revision: 'rev_x', datasetVersionId: 'dsv_1', caseCount: 1 },
        scorerSpecs: specs,
      },
    );
  }

  it('forwards the run’s retained scorer specs to a transport that has none', async () => {
    // The retained thresholds are what give a replayed numeric score its `passed` verdict. They
    // used to be attached only to the auto-built transport, so `run.upload(new PlatformTransport())`
    // registered policy-less and the re-upload disagreed with the original run.
    mockBackend({});
    const explicit = new PlatformTransport('ds_1');
    await retainedRun().upload(explicit);
    assert.deepEqual(explicit.scorerSpecs, specs);
    const reg = calls.find((c) => c.url.endsWith('/evaluation-runs'))!;
    assert.equal(reg.body.scorers[0].threshold, 0.8);
    assert.equal(reg.body.scorers[0].direction, 'higher_is_better');
  });

  it('never overwrites specs the caller put on the transport', async () => {
    mockBackend({});
    const own = [{ name: 'acc', version: 'v2', value_type: 'numeric', threshold: 0.5 }];
    const explicit = new PlatformTransport('ds_1', { scorerSpecs: own });
    await retainedRun().upload(explicit);
    assert.deepEqual(explicit.scorerSpecs, own);
    assert.equal(
      calls.find((c) => c.url.endsWith('/evaluation-runs'))!.body.scorers[0].threshold,
      0.5,
    );
  });
});
