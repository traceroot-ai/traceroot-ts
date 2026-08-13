// Nothing a timed-out case abandons is left dangling.
//
// withTimeout races the case against its deadline and walks away from the loser, which is still a
// live promise. Promise.race subscribes to it, so its later rejection is already observed and no
// unhandledRejection fires (which, under the default --unhandled-rejections=throw, would take the
// process down long after the run reported the timeout correctly). This pins that property: the
// Python engine had to be fixed for the equivalent — it cancels a case's asyncio task and must
// now await it — and a timeout rewritten off Promise.race here would regress the same way.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../src/eval';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('timed-out cases leave nothing dangling', () => {
  it('a task that rejects after its case timed out is not an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await evaluate({
        name: 'r',
        dataset: [{ id: 'c0', input: 1, expected: 1 }],
        task: () =>
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 40)),
        scorers: [() => 1],
        timeout: 0.01,
        local: true,
      });

      assert.match(result.itemResults[0].error!, /TimeoutError/);
      await settle(120); // let the abandoned task lose its race and reject
      assert.deepEqual(seen, [], 'the abandoned task rejected with nobody listening');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
