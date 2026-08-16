// A non-finite numeric score is a scorer FAILURE, never a value.
//
// NaN / Infinity (a 0/0 ratio, a divergent average) are not JSON numbers. JSON.stringify turns
// them into `null`, silently persisting an empty score that poisons the aggregate mean, while
// Python's json.dumps emits a bare NaN token the backend's JSON.parse rejects — one poisoned
// score 400s the whole run. Both are wrong and they are wrong DIFFERENTLY, so the reporting
// boundary converts a non-finite value into an errored score in both SDKs.
// Parity with traceroot-py/tests/eval/test_nonfinite_scores.py.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { PlatformTransport } from '../src/eval/platform';
import type { EvalItemResult } from '../src/eval/results';
import type { RunHandle } from '../src/eval/transport';

type Call = { method: string; url: string; body: any };
let calls: Call[];
const realFetch = globalThis.fetch;

const RUN: RunHandle = { name: 'e', datasetName: 'd', metadata: null };

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', url: String(url), body });
    return new Response(JSON.stringify({ evaluation_run_id: 'run_1' }), { status: 200 });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function transport(): PlatformTransport {
  const t = new PlatformTransport('ds_1', { apiKey: 'tr-x', baseUrl: 'https://h' });
  t.runId = 'run_1';
  return t;
}

function item(value: unknown, name = 'ratio'): EvalItemResult {
  return {
    caseId: 'c0',
    input: { m: 1 },
    output: { m: 1 },
    expected: { m: 1 },
    scores: [{ name, value: value as number, comment: null, metadata: null, version: null }],
    scorerErrors: {},
    error: null,
    traceId: null,
    durationMs: 1,
  };
}

function resultBody(): any {
  return calls.find((c) => c.url.endsWith('/results'))!.body;
}

/** The raw JSON text that actually went out — `null` in it is what JSON.stringify(NaN) becomes. */
function resultWire(): string {
  return JSON.stringify(resultBody());
}

for (const [label, value] of [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
] as const) {
  describe(`a ${label} score`, () => {
    it('never reaches the wire as a number (nor as a silent null)', async () => {
      const t = transport();
      await t.recordItemResult(RUN, item(value));
      const score = resultBody().scores[0];
      assert.equal('numeric_value' in score, false);
      assert.equal('bool_value' in score, false);
      assert.equal('string_value' in score, false);
      assert.equal('passed' in score, false); // an errored score has no verdict
      assert.equal(/"numeric_value":null/.test(resultWire()), false);
    });

    it('is reported as an errored score', async () => {
      const t = transport();
      await t.recordItemResult(RUN, item(value));
      const score = resultBody().scores[0];
      assert.equal(score.scorer_name, 'ratio');
      assert.equal(score.scorer_version, 'unversioned');
      assert.match(score.error, /non-finite/);
    });

    it('errors the case and counts toward the completion totals', async () => {
      const t = transport();
      await t.recordItemResult(RUN, item(value));
      assert.equal(resultBody().status, 'errored');
      await t.finishRun(RUN);
      const complete = calls.find((c) => c.url.endsWith('/complete'))!.body;
      assert.equal(complete.scorer_error_count, 1);
      assert.equal(complete.scored_count, 0); // a case whose only score errored is not scored
      assert.equal(complete.status, 'completed_with_errors');
    });
  });
}

describe('finite scores are untouched', () => {
  it('a finite number still reports its value', async () => {
    const t = transport();
    await t.recordItemResult(RUN, item(0));
    const score = resultBody().scores[0];
    assert.equal(score.numeric_value, 0);
    assert.equal('error' in score, false);
  });

  it('the message names the metric and the value', async () => {
    const t = transport();
    await t.recordItemResult(RUN, item(NaN, 'quality'));
    // Byte-identical to the Python SDK's message for the same input.
    assert.equal(
      resultBody().scores[0].error,
      "ValueError: scorer 'quality' returned a non-finite score value (NaN); " +
        'a numeric score must be finite',
    );
  });

  it('infinities render language-neutrally', async () => {
    // Python spells these 'inf'/'-inf' and JavaScript 'Infinity'; the wire uses ONE spelling so
    // the same scorer bug reads identically from either SDK.
    for (const [value, rendered] of [
      [Infinity, 'Infinity'],
      [-Infinity, '-Infinity'],
    ] as const) {
      calls = [];
      await transport().recordItemResult(RUN, item(value));
      assert.ok(resultBody().scores[0].error.includes(`(${rendered})`));
    }
  });
});
