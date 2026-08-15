// integration closure: ONE resolver, ONE resolved value threaded through the local
// result and the cloud reporter. Parity with traceroot-py/tests/eval/test_main_score_closure.py.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, FakeTransport, resolveMainScoreName, MainScoreError } from '../src/eval';

const DS = [{ input: { m: 1 }, expected: { m: 1 } }];
const echo = (x: any) => x;

describe('main-score closure', () => {
  it('late-bound single metric resolves to the emitted name (never the function name)', async () => {
    const grade = () => ({ name: 'quality', value: 1.0 });
    const fake = new FakeTransport();
    const result = await evaluate({
      name: 'r',
      dataset: DS,
      task: echo,
      scorers: [grade as any],
      transport: fake,
    });
    assert.equal(result.mainScoreName, 'quality');
    assert.equal(result.passed, 1); // local status derives from quality
    assert.equal(fake.lastMainScoreName, 'quality'); // cloud completion carries the resolved name
    assert.ok(result.summary().includes('quality'));
  });

  it('explicit multi-metric selection is used everywhere', async () => {
    const accuracy = () => ({ name: 'accuracy', value: 0.0 }); // first scorer AND first metric
    const format = () => ({ name: 'format', value: 1.0 });
    const fake = new FakeTransport();
    const result = await evaluate({
      name: 'r',
      dataset: DS,
      task: echo,
      scorers: [accuracy as any, format as any],
      mainScore: 'format',
      transport: fake,
    });
    assert.equal(result.mainScoreName, 'format');
    assert.equal(fake.lastMainScoreName, 'format');
    // Status derives from format (1.0 -> passed), NOT accuracy (0.0 -> would be failed).
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 0);
  });

  it('missing main_score completes the run terminally, then throws', async () => {
    const acc = () => ({ name: 'accuracy', value: 1.0 });
    const fake = new FakeTransport();
    await assert.rejects(
      () =>
        evaluate({
          name: 'r',
          dataset: DS,
          task: echo,
          scorers: [acc as any],
          mainScore: 'missing',
          transport: fake,
        }),
      /accuracy/, // lists the emitted metrics
    );
    // The run was registered, then completed in a terminal 'failed' state before throwing --
    // never left orphaned in 'running'.
    assert.equal(fake.lastFinishStatus, 'failed');
  });

  it('no successful scores is unscored, not ambiguous', async () => {
    const boom = () => {
      throw new Error('scorer down');
    };
    const fake = new FakeTransport();
    const result = await evaluate({
      name: 'r',
      dataset: DS,
      task: echo,
      scorers: [boom as any],
      transport: fake,
    });
    assert.equal(result.mainScoreName, null); // unscored, not a misconfiguration
    assert.equal(result.notScored, 1);
    assert.equal(fake.lastFinishStatus, null); // completed normally, not 'failed'
  });

  it('multiple emitted metrics without a main are ambiguous (the one resolver)', () => {
    assert.throws(() => resolveMainScoreName(null, ['a', 'b']), MainScoreError);
    assert.equal(resolveMainScoreName(null, ['only']), 'only'); // single -> late-bound
    assert.equal(resolveMainScoreName(null, []), null); // none -> unscored
  });
});
