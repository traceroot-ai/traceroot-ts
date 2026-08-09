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
