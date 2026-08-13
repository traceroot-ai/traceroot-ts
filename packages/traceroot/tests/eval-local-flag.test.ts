// evaluate({ local: true }): run in full, report nothing.
//
// `transport` is the power knob — it names the sink a run reports to. `local: true` is the
// convenience for the common "just run it, don't report anywhere" case: the task and scorers
// execute in full and a complete EvalRunResult comes back, but nothing leaves the process. No
// credentials are needed, no dataset is auto-published, no run is registered. It is exactly
// `transport: new FakeTransport()` without making the user import a class named "Fake", so the two
// must stay observationally identical. Parity with traceroot-py/tests/eval/test_local_flag.py.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset, Evaluation, evaluate, evaluateAsync, FakeTransport } from '../src/eval';
import type { EvalRunResult } from '../src/eval';
import type { ScorerContext } from '../src/eval';
import { TraceRoot } from '../src/traceroot';

const realFetch = globalThis.fetch;

const MUTUALLY_EXCLUSIVE = /local: true OR transport/;

const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) =>
  JSON.stringify(ctx.output) === JSON.stringify(ctx.expected) ? 1 : 0;

function makeDataset(name = 'local-flag'): Dataset {
  const d = new Dataset(name);
  d.add({ m: 1 }, { id: 'c0', expected: { m: 1 } });
  d.add({ m: 2 }, { id: 'c1', expected: { m: 2 } });
  return d;
}

/** A dataset that was pulled/pushed — the shape that WOULD report on the default path. */
function makeSyncedDataset(): Dataset {
  const d = makeDataset('already-synced');
  d.datasetVersionId = 'dsv_9';
  d.baseVersionId = 'dsv_9';
  return d;
}

/** The observable shape of a run, minus the per-run ids and timings. */
function summarize(result: EvalRunResult) {
  return {
    name: result.name,
    counts: [result.caseCount, result.errored, result.notScored],
    scores: Object.fromEntries(
      Object.entries(result.scoreSummary).map(([k, v]) => [k, [v.mean, v.count]]),
    ),
    upload: [result.uploadState.status, result.uploadState.dashboardUrl],
    runId: result.runId,
  };
}

/** Fail loudly on the one route out of the process. */
function forbidNetwork(): void {
  globalThis.fetch = (() => {
    throw new Error('local: true must not reach the platform');
  }) as unknown as typeof fetch;
}

const TRANSPORT_METHODS = [
  'createRun',
  'registerItem',
  'recordItemResult',
  'recordScores',
  'finishRun',
  'publishDataset',
] as const;
const originals = new Map<string, unknown>();

/**
 * Every FakeTransport instance driven during the test, in first-use order. The engine's own
 * instance is not reachable from the caller, so the class prototype is the seam: seeing an
 * instance here proves the engine really routed the run through an in-memory FakeTransport
 * rather than skipping reporting altogether.
 */
function spyOnFakeTransports(): FakeTransport[] {
  const used: FakeTransport[] = [];
  const proto = FakeTransport.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of TRANSPORT_METHODS) {
    const original = proto[m]!;
    originals.set(m, original);
    proto[m] = function (this: FakeTransport, ...args: unknown[]) {
      if (!used.includes(this)) used.push(this);
      return original.apply(this, args);
    };
  }
  return used;
}

function restoreFakeTransport(): void {
  const proto = FakeTransport.prototype as unknown as Record<string, unknown>;
  for (const [m, original] of originals) proto[m] = original;
  originals.clear();
}

beforeEach(() => {
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_HOST_URL'];
  process.env['TRACEROOT_ENABLED'] = 'false';
  TraceRoot._clearCredentials();
  forbidNetwork();
});

afterEach(() => {
  restoreFakeTransport();
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_HOST_URL'];
  delete process.env['TRACEROOT_ENABLED'];
  TraceRoot._clearCredentials();
});

describe('local runs fully and reports nothing', () => {
  it('completes without credentials', async () => {
    const result = await evaluate({
      name: 'r',
      dataset: makeDataset(),
      task: echo,
      scorers: [exact],
      local: true,
    });

    assert.equal(result.caseCount, 2);
    assert.equal(result.errored, 0);
    assert.equal(result.scoreSummary['exact']?.mean, 1);
    assert.equal(result.scoreSummary['exact']?.count, 2);
    // A non-uploaded run: no server run id and no dashboard to link to.
    assert.equal(result.runId, null);
    assert.equal(result.uploadState.dashboardUrl, null);
  });

  it('the run is recorded in memory', async () => {
    const used = spyOnFakeTransports();

    await evaluateAsync({
      name: 'r',
      dataset: makeDataset(),
      task: echo,
      scorers: [exact],
      local: true,
    });

    assert.equal(used.length, 1); // one transport, and the caller never supplied it
    const kinds = used[0]!.calls.map((c) => c[0]);
    assert.equal(kinds.filter((k) => k === 'create_run').length, 1);
    assert.equal(kinds.filter((k) => k === 'register_item').length, 2);
    assert.equal(kinds.filter((k) => k === 'record_item_result').length, 2);
    assert.equal(kinds.filter((k) => k === 'finish_run').length, 1);
    assert.ok(!kinds.includes('publish_dataset'));
  });

  it('an Evaluation definition honors local', async () => {
    const result = await new Evaluation({
      name: 'r',
      dataset: makeDataset(),
      task: echo,
      scorers: [exact],
      local: true,
    }).run();
    assert.equal(result.caseCount, 2);
  });
});

describe('local on a synced dataset', () => {
  // A dataset with a version id is exactly what the default path reports against; local: true
  // still runs it, and still reports nothing and re-publishes nothing.
  it('runs local without reporting or re-publishing', async () => {
    process.env['TRACEROOT_API_KEY'] = 'tr-ambient';
    process.env['TRACEROOT_HOST_URL'] = 'https://h';
    TraceRoot._clearCredentials();
    const d = makeSyncedDataset();

    const result = await evaluate({
      name: 'r',
      dataset: d,
      task: echo,
      scorers: [exact],
      local: true,
    });

    assert.equal(result.caseCount, 2);
    assert.equal(result.runId, null);
    assert.equal(d.datasetVersionId, 'dsv_9'); // untouched: no re-publish
  });
});

describe('local and an explicit sink are mutually exclusive', () => {
  // local: true already answers "where does this report" — passing a sink too is a contradiction,
  // not a precedence puzzle.
  it('local + transport throws', async () => {
    await assert.rejects(
      () =>
        evaluate({
          name: 'r',
          dataset: makeDataset(),
          task: echo,
          scorers: [exact],
          local: true,
          transport: new FakeTransport(),
        }),
      MUTUALLY_EXCLUSIVE,
    );
  });

  // run(overrides) merges into the definition's options, so it can produce the very combination
  // the constructor rejects. The guard has to run on the MERGED options too, or the contradiction
  // reaches the engine from a definition that validated cleanly.
  it('run() rejects a transport override on a local definition', () => {
    const e = new Evaluation({
      name: 'r',
      dataset: makeDataset(),
      task: echo,
      scorers: [exact],
      local: true,
    });
    assert.throws(() => e.run({ transport: new FakeTransport() }), MUTUALLY_EXCLUSIVE);
  });

  it('run() rejects a local override on a transport definition', () => {
    const e = new Evaluation({
      name: 'r',
      dataset: makeDataset(),
      task: echo,
      scorers: [exact],
      transport: new FakeTransport(),
    });
    assert.throws(() => e.run({ local: true }), MUTUALLY_EXCLUSIVE);
  });

  it('an Evaluation definition with both throws at construction', () => {
    assert.throws(
      () =>
        new Evaluation({
          name: 'r',
          dataset: makeDataset(),
          task: echo,
          scorers: [exact],
          local: true,
          transport: new FakeTransport(),
        }),
      MUTUALLY_EXCLUSIVE,
    );
  });
});

describe('local is equivalent to an explicit FakeTransport', () => {
  it('same result shape and same recorded calls', async () => {
    const used = spyOnFakeTransports();
    const explicit = new FakeTransport();
    const viaTransport = await evaluate({
      name: 'r',
      dataset: makeDataset(),
      task: echo,
      scorers: [exact],
      transport: explicit,
    });
    const viaLocal = await evaluate({
      name: 'r',
      dataset: makeDataset(),
      task: echo,
      scorers: [exact],
      local: true,
    });

    assert.deepEqual(summarize(viaLocal), summarize(viaTransport));
    assert.equal(used.length, 2);
    assert.equal(used[0], explicit);
    assert.notEqual(used[1], explicit); // the local run brought its own, unprompted
    // The same set of calls reached both. Compared as a multiset: per-case results are recorded
    // in completion order, which concurrency leaves free to differ between runs.
    const sortCalls = (t: FakeTransport) => t.calls.map((c) => JSON.stringify(c)).sort();
    assert.deepEqual(sortCalls(used[1]!), sortCalls(explicit));
  });
});

describe('the default (non-local) path is unchanged', () => {
  // local defaults to false and only adds a branch: with credentials and a locally-authored
  // dataset, an unset local still auto-publishes and still reports over the wire.
  it('unset local still auto-publishes and reports', async () => {
    process.env['TRACEROOT_API_KEY'] = 'tr-test';
    process.env['TRACEROOT_HOST_URL'] = 'https://h';
    TraceRoot._clearCredentials();
    const posted: string[] = [];
    globalThis.fetch = (async (url: string, init?: { method?: string }) => {
      posted.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
      return new Response(JSON.stringify({ evaluation_run_id: 'evr_1' }), { status: 200 });
    }) as unknown as typeof fetch;

    const published: string[] = [];
    const d = makeDataset();
    d.push = (async () => {
      published.push(d.name);
      d.datasetVersionId = 'dsv_10';
      d.baseVersionId = 'dsv_10';
    }) as Dataset['push'];

    const result = await evaluate({ name: 'r', dataset: d, task: echo, scorers: [exact] });

    assert.deepEqual(published, ['local-flag']); // still auto-publishes
    assert.ok(posted.includes('POST /api/v1/public/evaluation-runs')); // still reports
    assert.equal(result.dataset?.datasetVersionId, 'dsv_10');
  });
});
