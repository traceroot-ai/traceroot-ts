// Cross-language normalized-definition parity + source/config provenance (TypeScript side).
// Equivalent Python and TypeScript definitions normalize to the SAME descriptor fields — identity,
// policy, AND the config-hash `version` (the fixture pins the exact `cfg_`, so a judge does not
// look edited just because it was re-authored in the other language). Only provenance
// (language/source) stays language-specific. Mirrors the Python test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Scorer, scorer, scorerMetadata } from '../src/eval/scorers';
import type { ScorerContext } from '../src/eval';

const FIX = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'scorer_definition_parity.json'), 'utf8'),
) as { code: Record<string, unknown>; static_judge: Record<string, unknown> };

describe('normalized-definition parity + provenance (TS)', () => {
  it('code definition matches the parity fixture', () => {
    const grade = Scorer.code(
      { key: 'grade', valueType: 'numeric', direction: 'higher_is_better', threshold: 1 },
      (_c: ScorerContext) => 1,
    );
    const md = scorerMetadata(grade) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(FIX.code)) assert.equal(md[k], v, `${k}`);
  });

  it('static judge definition matches the parity fixture', () => {
    const j = Scorer.llmJudge({
      key: 'nc',
      name: 'nc',
      model: 'claude-sonnet-5',
      rubric: 'Return 1 if the answer has no conclusion, otherwise 0.',
      outputType: 'score',
      threshold: 1,
      direction: 'higher_is_better',
    });
    const md = scorerMetadata(j) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(FIX.static_judge)) assert.equal(md[k], v, `${k}`);
  });

  it('plain callable captures source WITHOUT a wrapper', () => {
    function plain(_c: ScorerContext) {
      return 1;
    }
    const md = scorerMetadata(plain as any);
    assert.equal(md.language, 'typescript');
    assert.ok((md.source ?? '').includes('plain'));
    assert.equal(md.key, 'plain'); // documented fallback: the function name
  });

  it('dynamic judge captures config hash AND builder provenance', () => {
    const nc = Scorer.llmJudge(
      {
        name: 'nc',
        model: 'claude-sonnet-5',
        rubric: 'Evaluate {{X}}.',
        threshold: 1,
        complete: () => '1',
      },
      ({ output }: ScorerContext) => ({ X: output }),
    );
    const md = scorerMetadata(nc);
    assert.ok((md.version ?? '').startsWith('cfg_'));
    assert.ok((md.source ?? '').includes('X')); // builder callback source captured
  });

  it('static judge needs no function and captures no code source', () => {
    const j = Scorer.llmJudge({
      name: 's',
      model: 'claude-sonnet-5',
      rubric: 'Grade 0..1.',
      threshold: 1,
    });
    const md = scorerMetadata(j);
    assert.ok((md.version ?? '').startsWith('cfg_'));
    assert.equal(md.source, undefined); // static judge: no code source
  });

  it('scorer() alias === Scorer.code semantics (metadata)', () => {
    const s = scorer((_c: ScorerContext) => 1, { key: 'k', threshold: 1 });
    assert.equal(scorerMetadata(s).key, 'k');
  });
});
