// One canonical form, shared with Python (C2/C3/C4).
//
// Every vector here is asserted against the SAME fixture bytes by
// `traceroot-py/tests/eval/test_canonical.py`, so a divergence in either SDK fails a test in that
// SDK instead of silently forking a dataset on the platform.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CASE_FIXTURE, SCORER_FIXTURE, decode } from './parity_vectors';
import { canonicalJson, normalize, CanonicalizationError } from '../src/eval/canonical';
import { Dataset } from '../src/eval/types';
import { llmJudge, scorerMetadata } from '../src/eval/scorers';

describe('canonical JSON matches the shared cross-SDK fixture', () => {
  for (const vector of CASE_FIXTURE.cases) {
    it(vector._comment, () => {
      assert.equal(canonicalJson(decode(vector.input)), vector.canonical_json);
    });
  }

  it('case ids and the content revision match the shared fixture', () => {
    const d = new Dataset(CASE_FIXTURE.dataset_key);
    assert.equal(d.datasetId, CASE_FIXTURE.dataset_id);
    for (const vector of CASE_FIXTURE.cases) {
      assert.equal(d.add(decode(vector.input)).id, vector.id, vector._comment);
    }
    assert.equal(d.snapshot().revision, CASE_FIXTURE.revision);
  });
});

describe('judge config hash', () => {
  it('matches the shared fixture cfg_ (same rubric, same version, either language)', () => {
    const fix = SCORER_FIXTURE.static_judge;
    const md = scorerMetadata(
      llmJudge({
        key: fix.key as string,
        name: fix.key as string,
        model: fix.model as string,
        rubric: 'Return 1 if the answer has no conclusion, otherwise 0.',
        outputType: fix.output_type as 'score',
        threshold: fix.threshold as number,
        direction: fix.direction as 'higher_is_better',
      }),
    );
    assert.equal(md.version, fix.version);
  });

  it('matches the shared fixture cfg_ when metadata exercises the canonicalizer', () => {
    const fix = SCORER_FIXTURE.judge_with_metadata;
    const md = scorerMetadata(
      llmJudge({
        key: fix.key as string,
        name: fix.key as string,
        model: fix.model as string,
        rubric: 'Grade {{output}} against {{expected}}.',
        outputType: fix.output_type as 'score',
        threshold: fix.threshold as number,
        direction: fix.direction as 'lower_is_better',
        valueType: fix.value_type as 'numeric',
        metadata: fix.metadata as Record<string, unknown>,
      }),
    );
    assert.equal(md.version, fix.version);
  });

  it('a changed rubric changes the version', () => {
    // Half the versioning contract: a constant-returning hash would pass everything above.
    const build = (rubric: string) =>
      scorerMetadata(llmJudge({ name: 'j', model: 'm', rubric, threshold: 1 })).version;
    assert.notEqual(build('Grade strictly.'), build('Grade leniently.'));
  });
});

describe('normalization rules', () => {
  it('normalize is the wire form and is idempotent', () => {
    const value = {
      d: new Date('2020-01-01T00:00:00.000Z'),
      s: new Set([2, 1]),
      b: Uint8Array.from([104, 105]),
      n: NaN,
    };
    const once = normalize(value);
    assert.deepEqual(once, {
      d: '2020-01-01T00:00:00.000Z',
      s: [1, 2],
      b: [104, 105],
      n: 'NaN',
    });
    // Re-normalizing what went on the wire must not change it — this is what makes a pulled
    // dataset re-hash to the revision that published it.
    assert.equal(canonicalJson(once), canonicalJson(value));
  });

  it('object keys sort by code point, not UTF-16 code unit', () => {
    // U+E000 (private use) sorts BEFORE U+1D11E by code point, and AFTER it by UTF-16 code unit
    // (which is what Array.prototype.sort() does by default).
    const astral = String.fromCodePoint(0x1d11e);
    const pua = String.fromCodePoint(0xe000);
    assert.equal(canonicalJson({ [astral]: 1, [pua]: 2 }), `{"${pua}":2,"${astral}":1}`);
  });

  it('numeric-string keys sort as strings despite JS object key ordering', () => {
    // Object.keys puts integer-like keys first in ASCENDING NUMERIC order, so a canonicalizer
    // that assigns into an object and then stringifies emits {"2":..,"10":..}.
    const o: Record<string, unknown> = {};
    o['10'] = 'a';
    o['2'] = 'b';
    assert.deepEqual(Object.keys(o), ['2', '10']); // the trap
    assert.equal(canonicalJson(o), '{"10":"a","2":"b"}');
  });

  it('an aliased reference hashes as content but a cycle is rejected', () => {
    const shared = { x: 1 };
    assert.equal(
      canonicalJson({ a: shared, b: shared }),
      canonicalJson({ a: { x: 1 }, b: { x: 1 } }),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalJson(cyclic), /reference cycle/);
  });

  it('NaN and Infinity are sentinel strings in both SDKs', () => {
    assert.equal(canonicalJson([NaN, Infinity, -Infinity]), '["NaN","Infinity","-Infinity"]');
  });

  it('negative zero and integral floats render as integers', () => {
    assert.equal(
      canonicalJson({ a: -0, b: 1.0, c: 1e21, d: 1e-7 }),
      '{"a":0,"b":1,"c":1e+21,"d":1e-7}',
    );
  });

  it('non-JSON values are rejected, not hashed in a language-specific shape', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    for (const bad of [new Point(1), () => 1, Symbol('s'), 1n]) {
      assert.throws(() => canonicalJson(bad), CanonicalizationError);
    }
  });

  it('a lone surrogate is rejected, not silently hashed', () => {
    // A lone UTF-16 surrogate can't encode to UTF-8: Python raises while hashing it and this SDK
    // would silently hash the escaped form. Both must reject it as a CanonicalizationError.
    for (const bad of ['\uD800', { k: 'lo\uDC00' }, { '\uD834': 'v' }]) {
      assert.throws(() => canonicalJson(bad), /surrogate/);
    }
  });

  it('a valid astral character still canonicalizes', () => {
    // A real non-BMP character (a surrogate PAIR) is valid text, not a lone surrogate.
    assert.equal(canonicalJson('\u{1F600}'), '"\u{1F600}"');
  });

  it('Dataset.add/upsert reject a non-serializable payload, naming the field', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    assert.throws(() => new Dataset('d').add(1, { expected: new Point(1) }), /test case expected/);
    assert.throws(() => new Dataset('d').upsert({ input: () => 1, id: 'a' }), /test case input/);
  });
});
