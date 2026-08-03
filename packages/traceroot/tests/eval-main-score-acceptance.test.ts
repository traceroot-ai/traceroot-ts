// B1 acceptance matrix, driven by the SHARED fixture (identical copy in traceroot-py). The
// single scorer's declared threshold + direction apply to its emitted metric, one policy across
// local + cloud, with an honest terminal failure (no orphaned run) on ambiguity. Mirrors
// traceroot-py/tests/eval/test_main_score_acceptance.py off the same fixture.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { evaluate, caseStatus, MainScoreError, FakeTransport } from '../src/eval';
import { scorer } from '../src/eval/scorers';
import type { Score, ScorerContext } from '../src/eval/types';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(here, 'fixtures', 'main_score_acceptance.json'), 'utf8'),
) as { main_score_acceptance: AcceptanceCase[] };

interface ScorerSpec {
  fn_name: string;
  threshold: number;
  direction: 'higher_is_better' | 'lower_is_better' | 'none';
  emit?: Score;
  emit_scalar?: number;
  emit_multi?: Score[];
  emit_by_case?: Score[];
}
interface AcceptanceCase {
  name: string;
  cases: number;
  main_score: string | null;
  scorers: ScorerSpec[];
  expect: { status?: string; main_score_name?: string; error?: boolean; terminal_failed?: boolean };
}

function buildScorer(spec: ScorerSpec) {
  let fn: (ctx: ScorerContext) => Score | Score[] | number;
  if (spec.emit_scalar !== undefined) {
    const v = spec.emit_scalar;
    fn = () => v;
  } else if (spec.emit_multi !== undefined) {
    const m = spec.emit_multi;
    fn = () => m.map((s) => ({ name: s.name, value: s.value }));
  } else if (spec.emit_by_case !== undefined) {
    const by = spec.emit_by_case;
    fn = (ctx) => {
      const s = by[(ctx.input as { i: number }).i];
      return { name: s.name, value: s.value };
    };
  } else {
    const e = spec.emit as Score;
    fn = () => ({ name: e.name, value: e.value });
  }
  // Mirror the py harness (fn.__name__ = fn_name): a scalar/boolean return is named after the
  // scorer function itself, so give the function its declared name.
  Object.defineProperty(fn, 'name', { value: spec.fn_name, configurable: true });
  return scorer(fn, {
    name: spec.fn_name,
    valueType: 'numeric',
    threshold: spec.threshold,
    direction: spec.direction,
  });
}

const finishCalls = (fake: FakeTransport): unknown[][] =>
  fake.calls.filter((c) => c[0] === 'finish_run');

describe('B1 main-score acceptance matrix (shared fixture)', () => {
  for (const testCase of FIX.main_score_acceptance) {
    it(testCase.name, async () => {
      const scorers = testCase.scorers.map(buildScorer);
      const dataset = Array.from({ length: testCase.cases }, (_, i) => ({ input: { i } }));
      const fake = new FakeTransport();
      const exp = testCase.expect;

      const run = () =>
        evaluate({
          name: 'acc',
          dataset,
          task: (x) => x,
          scorers,
          mainScore: testCase.main_score ?? undefined,
          transport: fake,
        });

      if (exp.error) {
        await assert.rejects(run(), MainScoreError);
        if (exp.terminal_failed) {
          // Completed terminally as 'failed' before raising -- never orphaned in 'running'.
          assert.ok(
            finishCalls(fake).some((c) => c[1] === 'failed'),
            'expected a finish_run("failed") before the error',
          );
        }
        return;
      }

      const result = await run();
      assert.equal(result.mainScoreName, exp.main_score_name);
      // Completion payload carries the resolved name (acceptance #7 explicit selection).
      assert.equal(fake.lastMainScoreName, exp.main_score_name);
      // The one resolved policy drives every per-case status (local == cloud).
      for (const item of result.itemResults) {
        assert.equal(caseStatus(item, result.mainScore), exp.status);
      }
    });
  }
});
