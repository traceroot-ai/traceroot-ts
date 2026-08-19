// Transport seam parity (Python test_transport.py): FakeTransport wiring + cloud-only default.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset, evaluate, FakeTransport } from '../src/eval';
import type { ScorerContext } from '../src/eval';

function ds(n: number): Dataset {
  const d = new Dataset('d');
  for (let i = 0; i < n; i++) d.upsert({ input: i, id: `c${i}`, expected: i });
  return d;
}
const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);

describe('cloud-only default', () => {
  it('bare evaluate requires reporting (no credentials + inline dataset -> throws)', async () => {
    await assert.rejects(
      evaluate({ name: 'r', dataset: ds(1), task: echo, scorers: [exact] }),
      /reports to the TraceRoot platform/,
    );
  });
});

describe('FakeTransport wiring', () => {
  it('call order: create_run first, finish_run last, register before records', async () => {
    const fake = new FakeTransport();
    await evaluate({ name: 'r', dataset: ds(1), task: echo, scorers: [exact], transport: fake });
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
      dataset: ds(4),
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
    await evaluate({ name: 'r', dataset: ds(3), task: boom, scorers: [exact], transport: fake });
    const registered = new Set(fake.calls.filter((c) => c[0] === 'register_item').map((c) => c[1]));
    assert.deepEqual([...registered].sort(), ['c0', 'c1', 'c2']);
  });

  it('exactly one finish_run, reported uploaded', async () => {
    const fake = new FakeTransport();
    const result = await evaluate({
      name: 'r',
      dataset: ds(3),
      task: echo,
      scorers: [exact],
      transport: fake,
    });
    assert.equal(fake.calls.filter((c) => c[0] === 'finish_run').length, 1);
    assert.equal(result.uploadState.status, 'uploaded');
  });
});
