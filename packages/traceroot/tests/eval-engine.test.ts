// OE-8: execution kernel parity (Python OE-3): sync/async, ordering, concurrency, isolation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Dataset,
  evaluate as _evaluate,
  evaluateAsync as _evaluateAsync,
  FakeTransport,
} from '../src/eval';
import type { ScorerContext, Score } from '../src/eval';

// Cloud-only: a run always reports. These engine tests don't care about the wire, so default
// a non-network FakeTransport when the test doesn't pass one.
type EvalOpts = Parameters<typeof _evaluate>[0];
const evaluate = (o: EvalOpts) => _evaluate({ transport: new FakeTransport(), ...o });
const evaluateAsync = (o: EvalOpts) => _evaluateAsync({ transport: new FakeTransport(), ...o });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ds(n: number): Dataset {
  const d = new Dataset('d');
  for (let i = 0; i < n; i++) d.upsert({ input: i, id: `c${i}`, expected: i });
  return d;
}
const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);

describe('basic runs', () => {
  it('sync task + sync scorer', async () => {
    const result = await evaluate({ name: 'r', data: ds(3), task: echo, scorers: [exact] });
    assert.deepEqual(
      result.itemResults.map((it) => it.caseId),
      ['c0', 'c1', 'c2'],
    );
    assert.equal(result.scoreSummary.exact.mean, 1);
    assert.equal(result.scoreSummary.exact.count, 3);
  });

  it('async task + async scorer', async () => {
    const atask = async (x: unknown) => {
      await sleep(0);
      return x;
    };
    const ascore = async (ctx: ScorerContext) => {
      await sleep(0);
      return ctx.output === ctx.expected ? 1 : 0;
    };
    const result = await evaluateAsync({ name: 'r', data: ds(2), task: atask, scorers: [ascore] });
    assert.equal(result.scoreSummary.ascore.mean, 1);
  });

  it('evaluate resolves to a completed result and reports uploaded', async () => {
    const result = await evaluate({ name: 'r', data: ds(1), task: echo, scorers: [exact] });
    assert.equal(result.uploadState.status, 'uploaded');
    assert.equal(result.itemResults[0].traceId ?? null, result.itemResults[0].traceId); // defined key
  });
});

describe('ordering and concurrency', () => {
  it('deterministic input ordering', async () => {
    const slow = async (x: number) => {
      await sleep((5 - x) * 5);
      return x;
    };
    const result = await evaluateAsync({ name: 'r', data: ds(5), task: slow, scorers: [exact] });
    assert.deepEqual(
      result.itemResults.map((it) => it.caseId),
      ['c0', 'c1', 'c2', 'c3', 'c4'],
    );
    assert.deepEqual(
      result.itemResults.map((it) => it.output),
      [0, 1, 2, 3, 4],
    );
  });

  it('bounded concurrency', async () => {
    let cur = 0;
    let peak = 0;
    const tracked = async (x: unknown) => {
      cur++;
      peak = Math.max(peak, cur);
      await sleep(10);
      cur--;
      return x;
    };
    await evaluateAsync({
      name: 'r',
      data: ds(10),
      task: tracked,
      scorers: [exact],
      maxConcurrency: 2,
    });
    assert.ok(peak <= 2, `peak=${peak}`);
  });
});

describe('failure isolation', () => {
  it('task error isolates and skips scorers', async () => {
    const boom = (x: number) => {
      if (x === 1) throw new Error('nope');
      return x;
    };
    const result = await evaluate({ name: 'r', data: ds(3), task: boom, scorers: [exact] });
    const byId = Object.fromEntries(result.itemResults.map((it) => [it.caseId, it]));
    assert.ok(byId.c1.error?.includes('nope'));
    assert.deepEqual(byId.c1.scores, []);
    assert.equal(byId.c0.error, null);
    assert.ok(byId.c0.scores.length > 0);
  });

  it('scorer error isolates, siblings still score', async () => {
    const bad = () => {
      throw new Error('scorer boom');
    };
    const result = await evaluate({ name: 'r', data: ds(2), task: echo, scorers: [exact, bad] });
    const it = result.itemResults[0];
    assert.ok('bad' in it.scorerErrors);
    assert.ok(it.scorerErrors.bad.includes('scorer boom'));
    assert.ok(it.scores.some((s) => s.name === 'exact'));
  });
});

describe('score normalization', () => {
  const one = async (scorer: (ctx: ScorerContext) => unknown, mainScore?: string) =>
    (await evaluate({ name: 'r', data: ds(1), task: echo, scorers: [scorer as never], mainScore }))
      .itemResults[0];

  it('number scalar', async () => {
    const s = (_ctx: ScorerContext) => 0.5;
    const scores = (await one(s)).scores;
    assert.equal(scores.length, 1);
    assert.equal(scores[0].name, 's');
    assert.equal(scores[0].value, 0.5);
  });
  it('boolean scalar', async () => {
    const s = (_ctx: ScorerContext) => true;
    assert.equal((await one(s)).scores[0].value, true);
  });
  it('string scalar', async () => {
    const s = (_ctx: ScorerContext) => 'billing';
    assert.equal((await one(s)).scores[0].value, 'billing');
  });
  it('score object', async () => {
    const s = (_ctx: ScorerContext): Score => ({ name: 'custom', value: 0.9, comment: 'c' });
    const sc = (await one(s)).scores[0];
    assert.equal(sc.name, 'custom');
    assert.equal(sc.comment, 'c');
  });
  it('array of scores', async () => {
    const s = (_ctx: ScorerContext): Score[] => [
      { name: 'a', value: 1 },
      { name: 'b', value: 0 },
    ];
    // Two emitted metrics -> the run needs an explicit main_score (else it fails clearly).
    const names = new Set((await one(s, 'a')).scores.map((x) => x.name));
    assert.deepEqual([...names].sort(), ['a', 'b']);
  });
  it('null abstains', async () => {
    const s = (_ctx: ScorerContext) => null;
    assert.deepEqual((await one(s)).scores, []);
  });

  it('scalar score serializes with comment/metadata null (Python parity)', async () => {
    const s = (_ctx: ScorerContext) => 1;
    const score = (await one(s)).scores[0];
    assert.deepEqual(score, { name: 's', value: 1, comment: null, metadata: null });
  });

  it('malformed array element becomes a scorer error, not a crash', async () => {
    const bad = (_ctx: ScorerContext) => [{ value: 1 }] as never; // missing name
    const result = await evaluate({ name: 'r', data: ds(1), task: echo, scorers: [bad] });
    assert.ok('bad' in result.itemResults[0].scorerErrors);
  });
});

describe('data coercion and config errors', () => {
  it('array of eval cases', async () => {
    const result = await evaluate({
      name: 'r',
      data: [
        { input: 1, id: 'a', expected: 1 },
        { input: 2, id: 'b', expected: 2 },
      ],
      task: echo,
      scorers: [exact],
    });
    assert.deepEqual(
      result.itemResults.map((it) => it.caseId),
      ['a', 'b'],
    );
  });

  it('anonymous list items get positional ids', async () => {
    const result = await evaluate({
      name: 'r',
      data: [
        { input: 1, expected: 1 },
        { input: 2, expected: 2 },
      ],
      task: echo,
      scorers: [exact],
    });
    assert.deepEqual(
      result.itemResults.map((it) => it.caseId),
      ['case-0', 'case-1'],
    );
  });

  for (const [label, opts] of [
    ['empty name', { name: '', data: ds(1), task: echo, scorers: [exact] }],
    ['empty data', { name: 'r', data: ds(0), task: echo, scorers: [exact] }],
    ['task not function', { name: 'r', data: ds(1), task: 'nope' as never, scorers: [exact] }],
    ['empty scorers', { name: 'r', data: ds(1), task: echo, scorers: [] }],
    [
      'bad concurrency',
      { name: 'r', data: ds(1), task: echo, scorers: [exact], maxConcurrency: 0 },
    ],
  ] as const) {
    it(`throws on ${label}`, async () => {
      await assert.rejects(() => evaluate(opts as never));
    });
  }
});
