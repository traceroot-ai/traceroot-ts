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
