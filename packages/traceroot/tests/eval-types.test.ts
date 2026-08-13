// OE-7: Dataset stable-id upsert, ordering, identity, JSON (parity with Python OE-1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset } from '../src/eval';
import type { EvalCase } from '../src/eval';

describe('Dataset upsert', () => {
  it('explicit id replaces in place', () => {
    const ds = new Dataset('d');
    ds.upsert({ input: 1, id: 'a', expected: 'x' });
    ds.upsert({ input: 2, id: 'a', expected: 'y' });
    assert.equal(ds.size, 1);
    assert.equal(ds.get('a')?.input, 2);
    assert.equal(ds.get('a')?.expected, 'y');
  });

  it('upsert returns the stored (id-bearing) case', () => {
    const ds = new Dataset('d');
    const returned = ds.upsert({ input: 1, id: 'a' });
    assert.equal(returned.id, 'a');
    assert.equal(returned.input, 1);
  });

  it('anonymous case gets a stable content id (parity with Python upsert)', () => {
    // Content-derived, not random: a ULID here would fork the same case into a new server case
    // on every process, which is the one thing stable ids exist to prevent.
    const ds = new Dataset('d');
    const r0 = ds.upsert({ input: 'a' });
    const r1 = ds.upsert({ input: 'b' });
    assert.match(r0.id as string, /^tc_[0-9a-f]{20}$/);
    assert.match(r1.id as string, /^tc_[0-9a-f]{20}$/);
    assert.notEqual(r0.id, r1.id);
    assert.equal(ds.size, 2);
    assert.equal(new Dataset('d').upsert({ input: 'a' }).id, r0.id);
  });

  it('re-upsert of returned case is idempotent', () => {
    const ds = new Dataset('d');
    const stored = ds.upsert({ input: 'a' });
    ds.upsert(stored);
    assert.equal(ds.size, 1);
  });
});

describe('Dataset ordering and access', () => {
  it('iterates in insertion order', () => {
    const ds = new Dataset('d');
    ds.upsert({ input: 1, id: 'z' });
    ds.upsert({ input: 2, id: 'a' });
    ds.upsert({ input: 3, id: 'm' });
    assert.deepEqual(
      [...ds].map((c) => c.input),
      [1, 2, 3],
    );
  });

  it('replace keeps original position', () => {
    const ds = new Dataset('d');
    ds.upsert({ input: 1, id: 'z' });
    ds.upsert({ input: 2, id: 'a' });
    ds.upsert({ input: 99, id: 'z' });
    assert.deepEqual(
      [...ds].map((c) => c.input),
      [99, 2],
    );
  });

  it('get miss returns undefined', () => {
    const ds = new Dataset('d');
    assert.equal(ds.get('nope'), undefined);
  });
});

describe('Dataset toJSON', () => {
  it('is JSON-serializable and includes provenance', () => {
    const ds = new Dataset('billing');
    const c: EvalCase = {
      input: { m: 'hi' },
      id: 'a',
      expected: { r: 'billing' },
      sourceTraceId: 't1',
      sourceSpanId: 's1',
    };
    ds.upsert(c);
    const json = ds.toJSON();
    assert.equal(json.name, 'billing');
    const s = JSON.stringify(json);
    assert.ok(s.includes('billing'));
    assert.equal(json.cases[0].id, 'a');
    assert.equal(json.cases[0].sourceTraceId, 't1');
    assert.equal(json.cases[0].sourceSpanId, 's1');
  });
});

describe('the identity key is immutable', () => {
  // Every case id and the datasetId are hashed from `key`. A key mutated after construction
  // leaves both stale: the snapshot would advertise a `key` that no longer hashes to the
  // datasetId it is sent with, and the platform would file the version under a different
  // dataset than the ids belong to.
  it('reassigning key after construction throws', () => {
    const ds = new Dataset('billing');
    assert.throws(() => {
      (ds as { key: string }).key = 'renamed';
    }, TypeError);
    assert.equal(ds.key, 'billing');
  });

  it('the snapshot key still hashes to the datasetId', () => {
    const ds = new Dataset('billing', null, { key: 'billing-v1' });
    ds.add({ q: 1 });
    try {
      (ds as { key: string }).key = 'renamed';
    } catch {
      /* the point of the previous test; here we only care that identity held */
    }
    const snap = ds.snapshot();
    assert.equal(snap.key, 'billing-v1');
    assert.equal(snap.datasetId, new Dataset('x', null, { key: snap.key }).datasetId);
  });
});
