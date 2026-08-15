// Phase 3 — stable cross-language identity (TypeScript side of the shared fixture).
// Proves a scorer given the same explicit `key` in Python and TypeScript resolves to the SAME
// logical scorer identity, while provenance (function-name spelling, SDK language, source) is
// retained and DIFFERS across languages. The Python counterpart (test_cross_sdk_identity.py)
// asserts the same `key` from the same fixture.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scorer, scorerMetadata } from '../src/eval/scorers';
import type { ScorerContext } from '../src/eval';

const FIX = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'cross_sdk_identity.json'), 'utf8'),
) as { scorer_key: string; python: any; typescript: { language: string; fn_name: string } };

function coversBothCities(ctx: ScorerContext): number {
  // camelCase — a TypeScript spelling; diverges from the Python `covers_both_cities`.
  return ctx.output === ctx.expected ? 1.0 : 0.0;
}

describe('cross-SDK scorer identity', () => {
  it('scorer key is stable across languages, provenance differs', () => {
    const md = scorerMetadata(scorer(coversBothCities, { key: FIX.scorer_key, threshold: 1.0 }));
    // Stable SEMANTIC identity — identical to the value the Python fixture asserts.
    assert.equal(md.key, FIX.scorer_key);
    // Provenance differs from Python and is NOT the identity:
    assert.equal(md.name, FIX.typescript.fn_name); // function-name spelling (camelCase)
    assert.equal(md.language, FIX.typescript.language); // SDK language = typescript
    assert.ok((md.source ?? '').includes('coversBothCities'));
  });

  it('key defaults to the definition name when unset', () => {
    function freshScorer(ctx: ScorerContext) {
      return ctx.output === ctx.expected ? 1 : 0; // a distinct fn (scorer() attaches meta in place)
    }
    const md = scorerMetadata(scorer(freshScorer, { threshold: 1.0 }));
    assert.equal(md.key, 'freshScorer'); // no explicit key -> the definition name (diverges by language)
  });
});

// --- Content-based case ids: byte-identical across Python/TypeScript ------------------------
import { Dataset } from '../src/eval/types';

const CASE_FIX = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'case_id_parity.json'), 'utf8'),
) as {
  dataset_key: string;
  dataset_id: string;
  revision: string;
  cases: { input: unknown; id: string }[];
};

describe('cross-SDK case-id identity', () => {
  it('case ids match the cross-language fixture (byte-identical with Python)', () => {
    const d = new Dataset(CASE_FIX.dataset_key);
    assert.equal(d.datasetId, CASE_FIX.dataset_id);
    for (const c of CASE_FIX.cases) {
      const produced = d.add(c.input);
      assert.equal(produced.id, c.id);
    }
    // the local content revision is ALSO byte-identical across Python and TypeScript
    assert.equal(d.snapshot().revision, CASE_FIX.revision);
  });

  it('content-based: inserting a case does not shift other ids; reorder = same revision', () => {
    const a = new Dataset('k');
    a.add({ q: 'a' });
    a.add({ q: 'b' });
    const base = new Map(a.cases().map((c) => [(c.input as { q: string }).q, c.id]));

    const b = new Dataset('k');
    b.add({ q: 'z' }); // inserted before a and b
    b.add({ q: 'a' });
    b.add({ q: 'b' });
    const after = new Map(b.cases().map((c) => [(c.input as { q: string }).q, c.id]));
    assert.equal(after.get('a'), base.get('a')); // unchanged despite z inserted first
    assert.equal(after.get('b'), base.get('b'));

    const r1 = new Dataset('k');
    r1.add(1);
    r1.add(2);
    const r2 = new Dataset('k');
    r2.add(2);
    r2.add(1);
    assert.equal(r1.snapshot().revision, r2.snapshot().revision); // order-independent
  });

  it('duplicate inputs get distinct, collision-safe ids', () => {
    const d = new Dataset('k');
    const x0 = d.add({ q: 'x' });
    const x1 = d.add({ q: 'x' });
    assert.notEqual(x0.id, x1.id);
    d.remove(x0.id);
    const x2 = d.add({ q: 'x' });
    assert.notEqual(x2.id, x1.id);
  });
});
