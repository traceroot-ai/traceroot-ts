// Finalization honesty (parity with traceroot-py tests/eval/test_run_finalization.py).
//
// The completion call runs in the engine's `finally`, so it is the last thing that can go wrong —
// and the easiest place to lose the truth. Two rules: (1) a completion failure never MASKS the
// error the run already failed with, and on its own it surfaces as ONE clear error; (2) per-case
// result POSTs dropped on the floor are COUNTED on the upload state, so a run that reports
// "uploaded" with silently-missing results is detectable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset, EvalCompletionError, FakeTransport, evaluate } from '../src/eval';
import type { EvalItemResult, RunHandle, UploadState } from '../src/eval';
import type { ScorerContext } from '../src/eval';

function ds(n: number): Dataset {
  const d = new Dataset('d');
  for (let i = 0; i < n; i++) d.upsert({ input: i, id: `c${i}`, expected: i });
  return d;
}
const echo = (x: unknown) => x;
const ok = (_ctx: ScorerContext) => 1;

/** The live failure: /complete rejects the payload (400) after the run is done. */
class BrokenFinish extends FakeTransport {
  async finishRun(): Promise<UploadState> {
    throw new Error('HTTP 400: /complete rejected the payload');
  }
}

/** A backend that has not deployed the new per-case fields: every result POST 400s. */
class DroppingResults extends FakeTransport {
  async recordItemResult(_run: RunHandle, _item: EvalItemResult): Promise<void> {
    throw new Error("HTTP 400: unknown field 'passed'");
  }
}

describe('completion never masks the real error', () => {
  it('a run failure survives a failing completion', async () => {
    // Body throws AND finishRun rejects. The user must still see the real cause.
    const boom = () => {
      throw new Error('no running event loop');
    };
    const err = await evaluate({
      name: 'r',
      data: ds(1),
      task: echo,
      scorers: [ok],
      transport: new BrokenFinish(),
      onCaseComplete: boom,
    }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof Error);
    assert.match(err.message, /no running event loop/);
    assert.ok(!(err instanceof EvalCompletionError));
    // The completion failure is not lost either — it rides along as secondary context.
    assert.match(String((err as { completionError?: Error }).completionError?.message), /400/);
  });

  it('a completion failure alone is one clear error', async () => {
    const err = await evaluate({
      name: 'r',
      data: ds(1),
      task: echo,
      scorers: [ok],
      transport: new BrokenFinish(),
    }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof EvalCompletionError);
    assert.match(err.message, /\/complete rejected the payload/); // names the completion failure
    assert.match(err.message, /running/); // says what it means for the run
    // The transport error is carried as data, not chained — one error, not a cause chain.
    assert.equal(err.cause, undefined);
    assert.ok(err.completionError instanceof Error);
  });
});

describe('dropped per-case results are counted', () => {
  it('surfaces dropped result posts on the upload state', async () => {
    const run = await evaluate({
      name: 'r',
      data: ds(3),
      task: echo,
      scorers: [ok],
      transport: new DroppingResults(),
    });
    assert.equal(run.uploadState.status, 'uploaded');
    assert.equal(run.uploadState.failedResultCount, 3);
  });

  it('a clean run reports no dropped results', async () => {
    const run = await evaluate({
      name: 'r',
      data: ds(2),
      task: echo,
      scorers: [ok],
      transport: new FakeTransport(),
    });
    assert.equal(run.uploadState.failedResultCount, 0);
  });
});
