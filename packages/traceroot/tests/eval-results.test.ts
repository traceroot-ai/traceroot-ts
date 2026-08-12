// OE-7: result/summary types + aggregation parity (Python OE-2).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateScores, makeRunResult } from '../src/eval';
import type { EvalItemResult, Score } from '../src/eval';

function item(caseId: string, scores: Score[], opts: Partial<EvalItemResult> = {}): EvalItemResult {
  return {
    caseId,
    input: { m: caseId },
    output: { o: caseId },
    expected: null,
    scores,
    scorerErrors: {},
    error: null,
    traceId: null,
    durationMs: null,
    ...opts,
  };
}

describe('aggregateScores', () => {
  it('numeric mean', () => {
    const summ = aggregateScores([
      item('a', [{ name: 'acc', value: 1 }]),
      item('b', [{ name: 'acc', value: 0 }]),
    ]);
    assert.equal(summ.acc.mean, 0.5);
    assert.equal(summ.acc.count, 2);
  });

  it('boolean scores average', () => {
    const summ = aggregateScores([
      item('a', [{ name: 'hit', value: true }]),
      item('b', [{ name: 'hit', value: false }]),
    ]);
    assert.equal(summ.hit.mean, 0.5);
    assert.equal(summ.hit.count, 2);
  });

  it('categorical string scores count only', () => {
    const summ = aggregateScores([
      item('a', [{ name: 'label', value: 'billing' }]),
      item('b', [{ name: 'label', value: 'tech' }]),
    ]);
    assert.equal(summ.label.mean, null);
    assert.equal(summ.label.count, 2);
  });

  it('mixed numeric and string under one name', () => {
    const summ = aggregateScores([
      item('a', [{ name: 'x', value: 1 }]),
      item('b', [{ name: 'x', value: 'skip' }]),
    ]);
    assert.equal(summ.x.mean, 1);
    assert.equal(summ.x.count, 2);
  });

  it('empty', () => {
    assert.deepEqual(aggregateScores([]), {});
  });
});

describe('EvalRunResult.toJSON', () => {
  it('is JSON-serializable with explicit uploaded state', () => {
    const items = [item('a', [{ name: 'acc', value: 1 }]), item('b', [{ name: 'acc', value: 0 }])];
    const run = makeRunResult('routing-v2', items, { status: 'uploaded', dashboardUrl: null });
    // Python-identical snake_case artifact shape (cross-loadable + runner-readable).
    const json = run.toJSON() as any;
    assert.equal(json.name, 'routing-v2');
    assert.equal(json.upload.status, 'uploaded');
    assert.equal(json.score_summary.acc.mean, 0.5);
    assert.equal(json.item_results.length, 2);
    JSON.stringify(json); // must not throw
  });
});

describe('counts block (Python parity)', () => {
  // Python results.py to_dict()/__str__ is the reference: the SDK derives no case-level
  // pass/fail, so the artifact must not carry a fabricated passed/failed verdict.
  const items = [
    item('ok', [{ name: 'acc', value: 1 }]),
    item('taskerr', [], { error: 'boom' }),
    item('scorererr', [], { scorerErrors: { grade: 'kaboom' } }),
  ];
  const run = makeRunResult('r', items, { status: 'uploaded', dashboardUrl: null });

  it('exposes errored / notScored, not passed / failed / scoredCount', () => {
    assert.equal(run.caseCount, 3);
    assert.equal(run.errored, 2);
    assert.equal(run.notScored, 1);
    assert.equal(run.taskErrorCount, 1);
    assert.equal(run.scorerErrorCount, 1);
    // The pass/fail status API is gone — caseStatus can only return errored | not_scored,
    // so these getters could only ever have reported a fabricated zero.
    for (const dead of ['passed', 'failed', 'scoredCount', 'failures'])
      assert.equal(dead in (run as unknown as Record<string, unknown>), false, dead);
  });

  it('saved artifact counts match Python key-for-key', () => {
    const counts = (run.toJSON() as any).counts;
    assert.deepEqual(Object.keys(counts), [
      'case_count',
      'errored',
      'not_scored',
      'task_errors',
      'scorer_errors',
    ]);
    assert.deepEqual(counts, {
      case_count: 3,
      errored: 2,
      not_scored: 1,
      task_errors: 1,
      scorer_errors: 1,
    });
  });

  it('summary() head matches Python __str__', () => {
    assert.equal(
      run.summary().split('\n')[0],
      'EvalRunResult(name=r, cases=3, errored=2, not_scored=1, task_errors=1, upload=uploaded)',
    );
  });
});
