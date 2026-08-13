// `evaluationKey`: the stable identity a run is grouped by, separate from its display name.
//
// The backend groups runs by evaluation_key and falls back to evaluation_name when the SDK sends
// none — which makes the display name the identity, so renaming an evaluation forks its history,
// and a TypeScript and a Python run of the SAME evaluation only group if their names match
// character for character. The SDK therefore always sends a key (defaulting to the name, so
// nothing changes for a caller who never sets one) and lets it be set explicitly. Same design as
// a scorer's `key`. Parity with traceroot-py/tests/eval/test_evaluation_key.py.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset, evaluate } from '../src/eval';
import type { ScorerContext } from '../src/eval';
import { PlatformTransport } from '../src/eval/platform';
import type { PlatformTransportOptions } from '../src/eval/platform';

type Call = { url: string; body: any };
let calls: Call[];
const realFetch = globalThis.fetch;

const echo = (x: unknown) => x;
const ok = (_ctx: ScorerContext) => 1;

beforeEach(() => {
  calls = [];
  process.env['TRACEROOT_ENABLED'] = 'false';
  globalThis.fetch = (async (url: string, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ evaluation_run_id: 'run_1' }), { status: 200 });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_ENABLED'];
});

function transport(opts: PlatformTransportOptions = {}): PlatformTransport {
  return new PlatformTransport('ds_1', { apiKey: 'tr-x', baseUrl: 'https://h', ...opts });
}

function registerBody(): any {
  return calls.find((c) => c.url.endsWith('/evaluation-runs'))!.body;
}

function dataset(): Dataset {
  const d = new Dataset('d');
  d.upsert({ input: 1, id: 'c0', expected: 1 });
  d.datasetId = 'ds_1';
  d.datasetVersionId = 'dsv_1';
  return d;
}

describe('registration always carries a key', () => {
  it('defaults to the evaluation name', async () => {
    await transport().createRun('regression suite', 'd', null);
    assert.equal(registerBody().evaluation_key, 'regression suite');
    // The display name is still sent; the key is identity, the name is presentation.
    assert.equal(registerBody().evaluation_name, 'regression suite');
  });

  it('an explicit key overrides the name', async () => {
    await transport({ evaluationKey: 'checkout-flow' }).createRun(
      'Checkout Flow (nightly)',
      'd',
      null,
    );
    assert.equal(registerBody().evaluation_key, 'checkout-flow');
    assert.equal(registerBody().evaluation_name, 'Checkout Flow (nightly)');
  });

  it('sends the key verbatim for cross-language grouping', async () => {
    // The value on the wire is the key as written — no normalization, no language marker — so a
    // TypeScript and a Python run under the same key land in the same group.
    await transport({ evaluationKey: 'checkout-flow' }).createRun('ts runner', 'd', null);
    assert.equal(registerBody().evaluation_key, 'checkout-flow');
  });
});

describe('evaluate threads the key', () => {
  it('forwards an explicit key to registration', async () => {
    await evaluate({
      name: 'Nightly regression',
      dataset: dataset(),
      task: echo,
      scorers: [ok],
      transport: transport(),
      evaluationKey: 'nightly-regression',
    });
    assert.equal(registerBody().evaluation_key, 'nightly-regression');
  });

  it('without one, the name is the key', async () => {
    await evaluate({
      name: 'Nightly regression',
      dataset: dataset(),
      task: echo,
      scorers: [ok],
      transport: transport(),
    });
    assert.equal(registerBody().evaluation_key, 'Nightly regression');
  });

  it('a key set on the transport is not overwritten', async () => {
    await evaluate({
      name: 'n',
      dataset: dataset(),
      task: echo,
      scorers: [ok],
      transport: transport({ evaluationKey: 'from-the-transport' }),
      evaluationKey: 'from-the-call',
    });
    assert.equal(registerBody().evaluation_key, 'from-the-transport');
  });
});
