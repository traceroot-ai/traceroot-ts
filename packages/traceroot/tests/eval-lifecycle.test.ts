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

  it('save/load round-trips (.json and .jsonl)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const ds = new Dataset('tickets', 'd');
    ds.add({ m: 'hi' }, { id: 'a', expected: { r: 'billing' }, metadata: { s: 1 } });
    for (const ext of ['json', 'jsonl']) {
      const p = join(dir, `ds.${ext}`);
      ds.save(p);
      const loaded = Dataset.load(p);
      assert.equal(loaded.name, 'tickets');
      assert.deepEqual(loaded.get('a')!.input, { m: 'hi' });
      assert.deepEqual(loaded.get('a')!.expected, { r: 'billing' });
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
