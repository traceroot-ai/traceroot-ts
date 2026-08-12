// Parity: dataset authoring/snapshot/save-load + push seam (LocalDatasetSync / FakeDatasetSync
// / conflict) + ULID ids.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Dataset,
  FakeDatasetSync,
  LocalDatasetSync,
  DatasetConflictError,
  newRunId,
  newDatasetId,
} from '../src/eval';

describe('ids', () => {
  it('typed ULID ids, time-sortable-ish and unique', () => {
    assert.match(newDatasetId(), /^ds_[0-9A-Z]{26}$/);
    assert.match(newRunId(), /^run_[0-9A-Z]{26}$/);
    assert.notEqual(newRunId(), newRunId());
  });
});

describe('Dataset authoring + snapshot', () => {
  it('add/update/archive/remove + active vs archived', () => {
    const ds = new Dataset('d', 'desc');
    ds.add({ q: 1 } as unknown, { id: 'c0', expected: 1 });
    assert.throws(() => ds.add(2, { id: 'c0' }), /already exists/);
    ds.add(2, { id: 'c1' });
    ds.update('c1', { expected: 99 });
    assert.equal(ds.get('c1')!.expected, 99);
    ds.archive('c0');
    assert.equal(ds.size, 1); // c0 archived -> excluded from active
    assert.equal(ds.cases(true).length, 2);
    ds.remove('c1');
    assert.equal(ds.size, 0);
  });

  it('snapshot revision is content-addressed and stable', () => {
    const mk = () => {
      const d = new Dataset('d');
      d.add({ m: 'x' }, { id: 'a', expected: 1 });
      return d;
    };
    assert.equal(mk().snapshot().revision, mk().snapshot().revision);
    assert.match(mk().snapshot().revision, /^rev_[0-9a-f]{16}$/);
  });

  it('save/load round-trips metadata, archived cases, and value types (.json and .jsonl)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const ds = new Dataset('tickets', 'd');
    ds.add(
      { m: 'hi', n: 2, ok: true },
      { id: 'a', expected: { r: 'billing' }, metadata: { s: 1 } },
    );
    ds.add({ m: 'bye' }, { id: 'b' });
    ds.archive('b'); // archived cases are retained for lineage and must persist
    for (const ext of ['json', 'jsonl']) {
      const p = join(dir, `ds.${ext}`);
      ds.save(p);
      const loaded = Dataset.load(p);
      assert.equal(loaded.name, 'tickets');
      // number/boolean types survive the JSON round-trip (not coerced to strings).
      assert.deepEqual(loaded.get('a')!.input, { m: 'hi', n: 2, ok: true });
      assert.deepEqual(loaded.get('a')!.expected, { r: 'billing' });
      assert.deepEqual(loaded.get('a')!.metadata, { s: 1 }); // metadata preserved
      assert.ok(loaded.get('b')?.archived, 'archived case must round-trip');
    }
  });
});

describe('push seam', () => {
  it('LocalDatasetSync stays local', async () => {
    const ds = new Dataset('d');
    ds.add(1, { id: 'a' });
    const r = await ds.push(new LocalDatasetSync());
    assert.equal(r.status, 'local_only');
    assert.equal(ds.datasetVersionId, undefined);
  });

  it('FakeDatasetSync versions, idempotency, and conflict', async () => {
    const sync = new FakeDatasetSync();
    const ds = new Dataset('d');
    ds.add(1, { id: 'a' });
    const v1 = await ds.push(sync);
    assert.equal(v1.status, 'uploaded');
    assert.equal(ds.datasetVersionId, v1.datasetVersionId); // pinned
    // idempotent re-push of unchanged content -> same version
    const again = await ds.push(sync, v1.datasetVersionId);
    assert.equal(again.datasetVersionId, v1.datasetVersionId);
    // a stale base rejects
    sync.forceCurrentVersion('dsv_99');
    await assert.rejects(() => ds.push(sync, 'dsv_stale'), DatasetConflictError);
  });
});

// --- Existing-dataset confirmation on push (parity with test_dataset_sync.py) ---------------
import { PlatformDatasetSync, DatasetPublishAborted } from '../src/eval';
import { confirmNewVersion } from '../src/eval/dataset_sync';
import { PassThrough } from 'node:stream';

function mockPlatformSync(exists: boolean, publishedRev: string | null = 'rev_different') {
  const sync = Object.create(PlatformDatasetSync.prototype) as PlatformDatasetSync & {
    calls: string[];
  };
  (sync as unknown as { apiKey: string }).apiKey = 'k';
  (sync as unknown as { baseUrl: string }).baseUrl = 'https://h';
  (sync as unknown as { calls: string[] }).calls = [];
  (sync as unknown as { request: unknown }).request = async (method: string, path: string) => {
    (sync as unknown as { calls: string[] }).calls.push(`${method} ${path}`);
    if (method === 'GET') {
      if (exists) return { name: 'd', current_dataset_version_id: 'dsv_9' };
      throw new Error('GET .../datasets/x -> HTTP 404: not found');
    }
    if (path.endsWith('/versions')) return { dataset_version_id: 'dsv_10', version_number: 2 };
    return {};
  };
  // Stub the published-revision fetch: `publishedRev` drives changed-vs-unchanged detection.
  (sync as unknown as { publishedRevision: unknown }).publishedRevision = async () => publishedRev;
  return sync;
}

function snap() {
  const d = new Dataset('d');
  d.add({ q: 'a' });
  return d.snapshot();
}

describe('existing-dataset confirmation on push (TS)', () => {
  it('unchanged content is a no-op without prompting', async () => {
    const s = snap();
    const sync = mockPlatformSync(true, s.revision) as PlatformDatasetSync & { calls: string[] };
    let called = false;
    const res = await sync.pushDataset(s, null, {
      onExisting: () => {
        called = true;
        return true;
      },
    });
    assert.equal(res.datasetVersionId, 'dsv_9'); // reuses the current version
    assert.equal(called, false); // unchanged -> never prompts
    assert.ok(!sync.calls.some((c) => c.endsWith('/versions'))); // no new version published
  });

  it('declined publish to an existing (changed) dataset aborts without creating a version', async () => {
    const sync = mockPlatformSync(true) as PlatformDatasetSync & { calls: string[] };
    await assert.rejects(
      () => sync.pushDataset(snap(), null, { onExisting: () => false }),
      DatasetPublishAborted,
    );
    assert.ok(!sync.calls.some((c) => c.endsWith('/versions'))); // no version was published
  });

  it('accepted publish to an existing dataset creates a new version', async () => {
    const sync = mockPlatformSync(true) as PlatformDatasetSync & { calls: string[] };
    const res = await sync.pushDataset(snap(), null, { onExisting: () => true });
    assert.equal(res.datasetVersionId, 'dsv_10');
  });

  it('a brand-new dataset never prompts', async () => {
    let called = false;
    const sync = mockPlatformSync(false);
    await sync.pushDataset(snap(), null, {
      onExisting: () => {
        called = true;
        return true;
      },
    });
    assert.equal(called, false); // 404 -> new -> confirmation never invoked
  });

  it('default confirmer proceeds when non-interactive (no TTY)', async () => {
    const sync = mockPlatformSync(true); // existing, but no onExisting -> default confirmer
    const res = await sync.pushDataset(snap(), null); // process.stdin.isTTY is falsy in the test env
    assert.equal(res.datasetVersionId, 'dsv_10');
  });

  it('default confirmer declines on EOF at the prompt', async () => {
    // The prompt defaults to NO; EOF is no answer at all, so it must decline too. Answering
    // "yes" to a question nobody read is exactly the accidental publish the prompt prevents.
    delete process.env['TRACEROOT_ASSUME_YES'];
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    input.end(); // EOF: no answer will ever arrive
    const answered = confirmNewVersion(
      { name: 'd', current_dataset_version_id: 'dsv_9' },
      input as unknown as NodeJS.ReadStream,
      new PassThrough(), // swallow the prompt instead of writing it to the test output
    );
    assert.equal(await answered, false);
  });
});
