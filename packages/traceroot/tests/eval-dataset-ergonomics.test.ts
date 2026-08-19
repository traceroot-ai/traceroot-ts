// Dataset ergonomics: the paths where a dataset silently loses its identity or its edit.
//
// Each test pins a behaviour a user relies on but that no fixture exercised: auto-provision that
// leaves the dataset fully pinned, a datasetVersionId that survives save/load, an existence check
// that only treats a real 404 as "new", an anonymous upsert that converges like add(), an accurate
// cloud-only error, a metadata-only push that is not a no-op, and a `key` that survives save/load
// and pull. Parity with traceroot-py/tests/eval/test_dataset_ergonomics.py.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Dataset, evaluate, pullDataset, PlatformDatasetSync } from '../src/eval';
import type { ScorerContext } from '../src/eval';
import { stableDatasetId } from '../src/eval/ids';
import { DATASET_KEY_FIXTURE } from './parity_vectors';

const realFetch = globalThis.fetch;
const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'traceroot-eval-')), name);
}

/** A PlatformDatasetSync with the credential constructor bypassed. */
function makeSync(): PlatformDatasetSync {
  const sync = Object.create(PlatformDatasetSync.prototype) as PlatformDatasetSync;
  (sync as unknown as { apiKey: string }).apiKey = 'k';
  (sync as unknown as { baseUrl: string }).baseUrl = 'https://h';
  return sync;
}

type Call = { method: string; url: string; body: any };

/** Route the GET existence check through `onGet` and record every call. */
function stubTransport(sync: PlatformDatasetSync, onGet: () => any): Call[] {
  const calls: Call[] = [];
  (sync as unknown as { request(m: string, p: string, b?: unknown): Promise<any> }).request =
    async (method, path, body) => {
      calls.push({ method, url: path, body });
      if (method === 'GET') return onGet();
      if (path.endsWith('/versions')) return { dataset_version_id: 'dsv_10', version_number: 2 };
      return {};
    };
  return calls;
}

function snapOf(name = 'd') {
  const d = new Dataset(name);
  d.add({ q: 'a' });
  return d.snapshot();
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_HOST_URL'];
  delete process.env['TRACEROOT_ENABLED'];
});

describe('existence-check errors', () => {
  // Swallowing every error there skips BOTH the idempotent no-op and the confirmation prompt,
  // so an expired key / 500 / timeout publishes an unprompted new version.
  it('a non-404 propagates instead of becoming a new dataset', async () => {
    const sync = makeSync();
    const calls = stubTransport(sync, () => {
      throw new Error('GET https://h/... -> HTTP 500: upstream exploded');
    });
    await assert.rejects(
      () => sync.pushDataset(snapOf(), null, { onExisting: async () => true }),
      /HTTP 500/,
    );
    assert.equal(
      calls.filter((c) => c.url.endsWith('/versions')).length,
      0,
      'nothing may be published on the way out',
    );
  });

  it('an auth failure propagates', async () => {
    const sync = makeSync();
    stubTransport(sync, () => {
      throw new Error('GET https://h/... -> HTTP 401: bad key');
    });
    await assert.rejects(() => sync.pushDataset(snapOf(), null), /HTTP 401/);
  });

  it('a 404 still means new (and never prompts)', async () => {
    const sync = makeSync();
    stubTransport(sync, () => {
      throw new Error('GET https://h/... -> HTTP 404: not found');
    });
    let prompted = false;
    const res = await sync.pushDataset(snapOf(), null, {
      onExisting: async () => {
        prompted = true;
        return true;
      },
    });
    assert.equal(res.datasetVersionId, 'dsv_10');
    assert.equal(prompted, false);
  });
});

describe('anonymous upsert converges', () => {
  // A random ULID makes the same case fork into a new server case on every process, which is the
  // one thing content-addressed ids exist to prevent.
  it('two processes upserting the same input agree', () => {
    const a = new Dataset('billing').upsert({ input: { m: 'hi' } });
    const b = new Dataset('billing').upsert({ input: { m: 'hi' } });
    assert.equal(a.id, b.id);
  });

  it('an anonymous upsert matches add()', () => {
    const added = new Dataset('billing').add({ m: 'hi' });
    const upserted = new Dataset('billing').upsert({ input: { m: 'hi' } });
    assert.equal(upserted.id, added.id);
  });

  it('duplicate inputs get distinct occurrence ids', () => {
    const d = new Dataset('billing');
    const first = d.upsert({ input: { m: 'hi' } });
    const second = d.upsert({ input: { m: 'hi' } });
    assert.notEqual(first.id, second.id);
    assert.equal(d.size, 2);
  });

  it('an explicit id still wins', () => {
    assert.equal(new Dataset('billing').upsert({ input: { m: 'hi' }, id: 'c0' }).id, 'c0');
  });

  it('the key scopes the id', () => {
    const a = new Dataset('billing', null, { key: 'k1' }).upsert({ input: { m: 'hi' } });
    const b = new Dataset('billing', null, { key: 'k2' }).upsert({ input: { m: 'hi' } });
    assert.notEqual(a.id, b.id);
  });
});

describe('metadata-only push', () => {
  // name/description are not part of the content revision, so the unchanged-revision short
  // circuit must still carry them rather than drop the edit silently.
  it('a description change reaches the platform', async () => {
    const d = new Dataset('d');
    d.add({ q: 'a' });
    const revision = d.snapshot().revision;

    const sync = makeSync();
    const calls = stubTransport(sync, () => ({
      name: 'old-name',
      current_dataset_version_id: 'dsv_9',
    }));
    (sync as unknown as { publishedRevision(): Promise<string> }).publishedRevision = async () =>
      revision;

    d.description = 'now documented';
    const res = await sync.pushDataset(d.snapshot(), null);

    const upserts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/datasets'));
    assert.equal(
      upserts.length,
      1,
      'the metadata upsert must be sent even when content is unchanged',
    );
    assert.equal(upserts[0]!.body.description, 'now documented');
    assert.equal(res.datasetVersionId, 'dsv_9'); // still an idempotent no-op version-wise
    assert.equal(calls.filter((c) => c.url.endsWith('/versions')).length, 0);
  });

  it('a declined publish mutates nothing', async () => {
    const sync = makeSync();
    const calls = stubTransport(sync, () => ({
      name: 'old-name',
      current_dataset_version_id: 'dsv_9',
    }));
    (sync as unknown as { publishedRevision(): Promise<string> }).publishedRevision = async () =>
      'rev_something_else';
    await assert.rejects(
      () => sync.pushDataset(snapOf(), null, { onExisting: async () => false }),
      /declined/,
    );
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });
});

describe('dataset key survives', () => {
  // `key` is what every case id is derived from, so losing it silently de-converges every case
  // added to a reloaded or pulled dataset.
  it('toJSON round trip preserves the key', () => {
    const d = new Dataset('Billing v2 (renamed)', null, { key: 'billing' });
    assert.equal(Dataset.fromJSON(JSON.parse(JSON.stringify(d.toJSON()))).key, 'billing');
  });

  it('a case added after reload matches local authoring', () => {
    const d = new Dataset('Billing v2 (renamed)', null, { key: 'billing' });
    d.add({ m: 'first' });
    const path = tmpFile('ds.json');
    d.save(path);
    assert.equal(Dataset.load(path).add({ m: 'second' }).id, d.add({ m: 'second' }).id);
  });

  it('the jsonl header carries the key', () => {
    const d = new Dataset('Billing v2 (renamed)', null, { key: 'billing' });
    d.add({ m: 'first' });
    const path = tmpFile('ds.jsonl');
    d.save(path);
    assert.equal(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!).key, 'billing');
    assert.equal(Dataset.load(path).key, 'billing');
  });

  it('pull recovers the key from the dataset name', async () => {
    const local = new Dataset('billing');
    const first = local.add({ m: 'first' });
    installPullBackend('billing', local.datasetId, first.id);

    const pulled = await pullDataset(local.datasetId);
    assert.equal(pulled.key, 'billing');
    assert.equal(pulled.add({ m: 'second' }).id, local.add({ m: 'second' }).id);
  });

  it('pull never adopts a name that is not the key', async () => {
    // A display-name rename (key !== name) must not be mistaken for the key: the id derived from
    // it would be wrong. The dataset id is used instead — stable, and never a lie.
    const local = new Dataset('Billing v2 (renamed)', null, { key: 'billing' });
    installPullBackend('Billing v2 (renamed)', local.datasetId, 'tc_x');

    const pulled = await pullDataset(local.datasetId);
    assert.notEqual(pulled.key, 'Billing v2 (renamed)');
    assert.equal(pulled.key, local.datasetId);
    assert.notEqual(stableDatasetId('Billing v2 (renamed)'), local.datasetId);
  });
});

function installPullBackend(
  name: string,
  datasetId: string,
  caseId: string,
  meta: Record<string, unknown> = {},
): void {
  process.env['TRACEROOT_API_KEY'] = 'tr-test';
  process.env['TRACEROOT_HOST_URL'] = 'https://h';
  process.env['TRACEROOT_ENABLED'] = 'false';
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes('/dataset-versions/')) {
      return new Response(
        JSON.stringify({
          dataset_id: datasetId,
          dataset_version_id: 'dsv_1',
          items: [{ test_case_id: caseId, input: { m: 'first' } }],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ name, current_dataset_version_id: 'dsv_1', ...meta }), {
      status: 200,
    });
  }) as any;
}

describe('dataset key on the wire', () => {
  // The key is the dataset's identity, so it belongs on the wire: without it the platform can
  // only guess (name-hash), and a UI rename or an explicit key leaves every later case divergent.
  const fix = DATASET_KEY_FIXTURE;

  function upserts(calls: Call[]) {
    return calls.filter((c) => c.method === 'POST' && c.url.endsWith('/datasets'));
  }

  function newDatasetSync(): { sync: PlatformDatasetSync; calls: Call[] } {
    const sync = makeSync();
    const calls = stubTransport(sync, () => {
      throw new Error('GET https://h/... -> HTTP 404: not found');
    });
    return { sync, calls };
  }

  it('push sends the key', async () => {
    const { sync, calls } = newDatasetSync();
    await sync.pushDataset(snapOf('billing'), null);
    assert.equal(upserts(calls)[0]!.body.key, 'billing'); // default key === name
  });

  it('push sends an explicit key', async () => {
    const d = new Dataset(fix.display_name, null, { key: fix.dataset_key });
    d.add(fix.existing_case.input);
    const { sync, calls } = newDatasetSync();
    await sync.pushDataset(d.snapshot(), null);
    const body = upserts(calls)[0]!.body;
    assert.equal(body.key, fix.dataset_key);
    assert.equal(body.name, fix.display_name); // the key is NOT the name
  });

  it('a metadata-only push sends the key too', async () => {
    // The unchanged-revision short circuit sends the metadata upsert; it must carry the key as
    // well, or the backfill never happens for an already-published dataset.
    const d = new Dataset('Billing', null, { key: 'billing' });
    d.add({ q: 'a' });
    const sync = makeSync();
    const calls = stubTransport(sync, () => ({
      name: 'Billing',
      current_dataset_version_id: 'dsv_9',
    }));
    (sync as unknown as { publishedRevision(): Promise<string> }).publishedRevision = async () =>
      d.snapshot().revision;
    await sync.pushDataset(d.snapshot(), null);
    assert.equal(upserts(calls)[0]!.body.key, 'billing');
  });

  it('pull prefers the key echoed by the platform', async () => {
    // The dataset response now CARRIES the key, so a renamed dataset is no longer a dead end: the
    // echoed key is adopted verbatim and every case added afterwards converges with local
    // authoring. The ids come from the shared fixture, so Python and TypeScript agree.
    const local = new Dataset(fix.display_name, null, { key: fix.dataset_key });
    const first = local.add(fix.existing_case.input);
    assert.equal(local.datasetId, fix.dataset_id);
    assert.equal(first.id, fix.existing_case.id);
    installPullBackend(fix.display_name, fix.dataset_id, first.id!, { key: fix.dataset_key });

    const pulled = await pullDataset(fix.dataset_id);
    assert.equal(pulled.key, fix.dataset_key);
    const added = pulled.add(fix.added_case.input);
    assert.equal(added.id, fix.added_case.id);
    assert.equal(added.id, local.add(fix.added_case.input).id);
  });

  it('pull falls back to the heuristic when the key is null', async () => {
    // Datasets that predate the `key` contract (or were authored in the UI) echo `key: null`, so
    // the name-hash recovery must stay in place for them.
    const local = new Dataset('billing');
    const first = local.add({ m: 'first' });
    installPullBackend('billing', local.datasetId, first.id!, { key: null });

    assert.equal((await pullDataset(local.datasetId)).key, 'billing');
  });
});

describe('datasetVersionId survives save/load', () => {
  // fromJSON reads it and Python keeps it, so dropping it on the way out loses the remote binding
  // — and evaluate()'s auto-provision guard then re-pushes an already-synced dataset.
  it('toJSON carries datasetVersionId', () => {
    const d = new Dataset('d');
    d.add({ m: 1 });
    d.datasetVersionId = 'dsv_7';
    assert.equal(d.toJSON().datasetVersionId, 'dsv_7');
  });

  it('save -> load round-trips datasetVersionId (.json)', () => {
    const d = new Dataset('d');
    d.add({ m: 1 });
    d.datasetVersionId = 'dsv_7';
    const path = tmpFile('ds.json');
    d.save(path);
    assert.equal(Dataset.load(path).datasetVersionId, 'dsv_7');
  });

  it('save -> load round-trips datasetVersionId (.jsonl)', () => {
    const d = new Dataset('d');
    d.add({ m: 1 });
    d.datasetVersionId = 'dsv_7';
    const path = tmpFile('ds.jsonl');
    d.save(path);
    assert.equal(Dataset.load(path).datasetVersionId, 'dsv_7');
  });
});

describe('evaluate() auto-provision', () => {
  /** A backend that publishes versions and absorbs the run reporting. */
  function installEvalBackend(): void {
    process.env['TRACEROOT_API_KEY'] = 'tr-test';
    process.env['TRACEROOT_HOST_URL'] = 'https://h';
    process.env['TRACEROOT_ENABLED'] = 'false';
    globalThis.fetch = (async (url: string, init?: any) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && u.match(/\/datasets\/[^/]+$/))
        return new Response('not found', { status: 404 });
      if (u.endsWith('/versions'))
        return new Response(JSON.stringify({ dataset_version_id: 'dsv_1', version_number: 1 }), {
          status: 200,
        });
      if (u.endsWith('/evaluation-runs'))
        return new Response(JSON.stringify({ evaluation_run_id: 'run_1' }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as any;
  }

  it('leaves the dataset fully pinned, not just versioned', async () => {
    // baseVersionId is the optimistic-concurrency base for the NEXT push. Assigning only
    // datasetVersionId leaves it null, so a later explicit push() sends base_version_id: null
    // against a dataset that now has a version — a spurious 409.
    installEvalBackend();
    const ds = new Dataset('auto-provision');
    ds.add({ m: 1 }, { expected: { m: 1 } });

    await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });

    assert.equal(ds.datasetVersionId, 'dsv_1');
    assert.equal(ds.baseVersionId, 'dsv_1');
  });
});

describe('cloud-only error names the real cause', () => {
  it('credentials present but data is not a synced dataset', async () => {
    process.env['TRACEROOT_API_KEY'] = 'tr-test';
    process.env['TRACEROOT_HOST_URL'] = 'https://h';
    process.env['TRACEROOT_ENABLED'] = 'false';
    await assert.rejects(
      () =>
        evaluate({
          name: 'r',
          dataset: [{ input: 1, id: 'c0', expected: 1 }],
          task: echo,
          scorers: [exact],
        }),
      (err: Error) => {
        assert.ok(!/no credentials/i.test(err.message), err.message);
        assert.match(err.message, /synced dataset/);
        return true;
      },
    );
  });

  it('no credentials says so', async () => {
    const ds = new Dataset('d');
    ds.add(1, { expected: 1 });
    await assert.rejects(
      () => evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] }),
      /no credentials were found/,
    );
  });
});

beforeEach(() => {
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_HOST_URL'];
});
