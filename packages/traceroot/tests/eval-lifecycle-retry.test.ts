// The two lifecycle calls survive a blip; everything else is left alone.
//
// Per-case result POSTs are already isolated — one that fails costs one case, and the loss is
// counted on the upload state. Run registration and completion are not: a single dropped packet
// on register aborts an evaluation before it runs a case, and one on complete leaves a finished
// run stuck in `running` on the platform forever. Those two get a small bounded retry — transient
// failures only, since a 400 will never get better.
// Parity with traceroot-py/tests/eval/test_lifecycle_retry.py.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { PlatformTransport, retryDelayMs } from '../src/eval/platform';
import type { EvalItemResult } from '../src/eval/results';
import type { RunHandle } from '../src/eval/transport';

const RUN: RunHandle = { name: 'e', datasetName: 'd', metadata: null };
const realFetch = globalThis.fetch;
let calls: string[];

/** Answer the first `failures` requests to EVERY endpoint with `status`, then succeed. */
function mockFlakyBackend(opts: { failures?: number; status?: number } = {}) {
  const failures = opts.failures ?? 1;
  const status = opts.status ?? 503;
  const remaining = new Map<string, number>();
  calls = [];
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    const key = u.replace(/^.*\/api/, '/api');
    const left = remaining.get(key) ?? failures;
    if (left > 0) {
      remaining.set(key, left - 1);
      return new Response('upstream unavailable', { status });
    }
    return new Response(JSON.stringify({ evaluation_run_id: 'run_1' }), { status: 200 });
  }) as any;
}

function transport(): PlatformTransport {
  const t = new PlatformTransport('ds_1', { apiKey: 'tr-x', baseUrl: 'https://h' });
  t.retryBaseDelayMs = 0; // no real waiting in tests; backoff is tested separately
  return t;
}

const tries = (suffix: string) => calls.filter((u) => u.endsWith(suffix)).length;

function item(): EvalItemResult {
  return {
    caseId: 'c0',
    input: 1,
    output: 1,
    expected: 1,
    scores: [],
    scorerErrors: {},
    error: null,
    traceId: null,
    durationMs: null,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('transient failures are retried', () => {
  it('createRun recovers', async () => {
    mockFlakyBackend();
    const t = transport();
    await t.createRun('e', 'd', null);
    assert.equal(t.runId, 'run_1');
    assert.equal(tries('/evaluation-runs'), 2);
  });

  it('finishRun recovers', async () => {
    mockFlakyBackend({ failures: 1 });
    const t = transport();
    await t.createRun('e', 'd', null);
    const state = await t.finishRun(RUN);
    assert.equal(state.status, 'uploaded');
    assert.equal(tries('/complete'), 2);
  });
});

describe('permanent failures are not', () => {
  it('a rejected payload is not retried', async () => {
    mockFlakyBackend({ failures: 99, status: 400 });
    await assert.rejects(() => transport().createRun('e', 'd', null), /HTTP 400/);
    assert.equal(tries('/evaluation-runs'), 1); // a 400 will never get better
  });

  it('it gives up and throws the real error', async () => {
    mockFlakyBackend({ failures: 99 });
    const t = transport();
    await assert.rejects(() => t.createRun('e', 'd', null), /HTTP 503/);
    assert.equal(tries('/evaluation-runs'), t.retryAttempts);
  });

  it('per-case results are not retried', async () => {
    // They are isolated by design: retrying every case's POST would multiply the load of a broken
    // backend by the retry count, and a dropped result is already counted.
    mockFlakyBackend({ failures: 0 });
    const t = transport();
    await t.createRun('e', 'd', null);
    mockFlakyBackend({ failures: 99 });
    t.runId = 'run_1';
    await assert.rejects(() => t.recordItemResult(RUN, item()));
    assert.equal(tries('/results'), 1);
  });
});

describe('backoff', () => {
  it('the delay doubles per attempt', () => {
    // Byte-identical to the Python SDK's _retry_delay_ms.
    assert.deepEqual(
      [1, 2, 3].map((n) => retryDelayMs(n, 500)),
      [500, 1000, 2000],
    );
  });
});
