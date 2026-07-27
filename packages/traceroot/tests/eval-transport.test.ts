// OE-8: transport seam parity (Python OE-5): LocalTransport, FakeTransport, publish().
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset, evaluate } from '../src/eval';
import { FakeTransport, LocalTransport } from '../src/eval';
import type { ScorerContext } from '../src/eval';

function ds(n: number): Dataset {
  const d = new Dataset('d');
  for (let i = 0; i < n; i++) d.upsert({ input: i, id: `c${i}`, expected: i });
  return d;
}
const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);

describe('LocalTransport', () => {
  it('finishRun is local_only', async () => {
    const t = new LocalTransport();
    const run = await t.createRun('r', 'd', null);
    const state = await t.finishRun(run);
    assert.equal(state.status, 'local_only');
    assert.equal(state.dashboardUrl, null);
  });

  it('default evaluate is local_only', async () => {
    const result = await evaluate({ name: 'r', data: ds(1), task: echo, scorers: [exact] });
    assert.equal(result.uploadState.status, 'local_only');
  });
});

describe('FakeTransport wiring', () => {
  it('call order: create_run first, finish_run last, register before records', async () => {
    const fake = new FakeTransport();
    await evaluate({ name: 'r', data: ds(1), task: echo, scorers: [exact], transport: fake });
    const kinds = fake.calls.map((c) => c[0]);
    assert.equal(kinds[0], 'create_run');
    assert.equal(kinds[kinds.length - 1], 'finish_run');
    assert.ok(kinds.indexOf('register_item') < kinds.indexOf('record_item_result'));
    assert.ok(kinds.indexOf('register_item') < kinds.indexOf('record_scores'));
  });

  it('register precedes result for every case', async () => {
    const fake = new FakeTransport();
    await evaluate({
      name: 'r',
      data: ds(4),
      task: echo,
      scorers: [exact],
      transport: fake,
      maxConcurrency: 1,
    });
    for (const cid of ['c0', 'c1', 'c2', 'c3']) {
      const reg = fake.calls.findIndex((c) => c[0] === 'register_item' && c[1] === cid);
      const rec = fake.calls.findIndex((c) => c[0] === 'record_item_result' && c[1] === cid);
      assert.ok(reg < rec, cid);
    }
  });

  it('register fires for erroring case', async () => {
    const boom = (x: number) => {
      if (x === 1) throw new Error('no');
      return x;
    };
    const fake = new FakeTransport();
    await evaluate({ name: 'r', data: ds(3), task: boom, scorers: [exact], transport: fake });
    const registered = new Set(fake.calls.filter((c) => c[0] === 'register_item').map((c) => c[1]));
    assert.deepEqual([...registered].sort(), ['c0', 'c1', 'c2']);
  });

  it('exactly one finish_run', async () => {
    const fake = new FakeTransport();
    await evaluate({ name: 'r', data: ds(3), task: echo, scorers: [exact], transport: fake });
    assert.equal(fake.calls.filter((c) => c[0] === 'finish_run').length, 1);
  });
});

describe('Dataset.publish', () => {
  it('returns a local_only PublishResult', async () => {
    const d = ds(3);
    const result = await d.publish();
    assert.equal(result.status, 'local_only');
    assert.equal(result.datasetName, 'd');
    assert.equal(result.itemCount, 3);
  });
});
