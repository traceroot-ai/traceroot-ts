// Parity: pull (native JSON, exact version, mismatch, 404), upload-by-default decision,
// and PlatformTransport wire payloads — with fetch mocked (no real network).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset, evaluate, pullDataset, pullDatasetVersion } from '../src/eval';
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

describe('reporting default (upload-by-default)', () => {
  it('no credentials -> local', async () => {
    // no api key set -> resolveCredentials returns empty -> stays local, no POST
    const ds = new Dataset('d');
    ds.datasetId = 'ds_1';
    ds.datasetVersionId = 'dsv_1';
    ds.upsert({ input: 1, id: 'c0', expected: 1 });
    const result = await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });
    assert.equal(result.uploadState.status, 'local_only');
    assert.equal(result.runId, null);
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
    assert.equal(res.body.status, 'passed');
    assert.equal(res.body.main_score, 1);
    assert.equal(typeof res.body.duration_ms, 'number');

    const done = calls.find((c) => c.url.endsWith('/complete'))!;
    assert.equal(done.body.main_score, 1); // aggregate
  });

  it('local:true opts out even with creds + remote dataset', async () => {
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
      local: true,
    });
    assert.equal(result.uploadState.status, 'local_only');
    assert.ok(!calls.some((c) => c.url.endsWith('/evaluation-runs')));
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
});

describe('run URL (run_path -> dashboardUrl)', () => {
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
