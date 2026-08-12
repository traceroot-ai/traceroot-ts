// Parity: pull (native JSON, exact version, mismatch, 404), upload-by-default decision,
// and PlatformTransport wire payloads — with fetch mocked (no real network).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset, evaluate, makeRunResult, pullDataset, pullDatasetVersion } from '../src/eval';
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

  it('mismatched dataset/version identity raises', async () => {
    mockBackend({ versions: { dsv_x: version('dsv_x', 'ds_OTHER') } });
    await assert.rejects(
      () => pullDatasetVersion('dsv_x', { datasetId: 'ds_1' }),
      /belongs to dataset/,
    );
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
