// Wire robustness parity with traceroot-py tests/eval/test_wire_robustness.py: the git
// commit hex gate, the declared version on an errored scorer, contract-cap clamping, a
// bounded HTTP call, an empty response body, honest single-scorer ownership, and a
// byte-identical summary().
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPLANATION_MAX,
  HTTP_TIMEOUT_MS,
  METADATA_MAX,
  PAYLOAD_TEXT_MAX,
  PlatformTransport,
  SCORE_ERROR_MAX,
  SCORER_SOURCE_MAX,
  STRING_VALUE_MAX,
  TASK_ERROR_MAX,
  TRUNCATION_SUFFIX,
  httpJson,
} from '../src/eval/platform';
import { collectRunProvenance } from '../src/eval/provenance';
import { makeRunResult } from '../src/eval/results';
import type { EvalItemResult } from '../src/eval/results';
import type { RunHandle } from '../src/eval/transport';

const realFetch = globalThis.fetch;
let calls: { url: string; method: string; body: any }[] = [];

/** Records every request and answers with the minimum the transport needs. */
function mockBackend() {
  calls = [];
  process.env['TRACEROOT_ENABLED'] = 'false';
  globalThis.fetch = (async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith('/evaluation-runs'))
      return new Response(JSON.stringify({ evaluation_run_id: 'run_1' }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
}

function transport(opts: Record<string, unknown> = {}) {
  return new PlatformTransport('ds_1', { apiKey: 'tr-x', baseUrl: 'https://h', ...opts });
}

function item(over: Partial<EvalItemResult> = {}): EvalItemResult {
  return {
    caseId: 'tc1',
    input: { m: 1 },
    output: { r: 1 },
    expected: { r: 1 },
    scores: [],
    scorerErrors: {},
    error: null,
    traceId: null,
    durationMs: null,
    ...over,
  };
}

const RUN: RunHandle = { name: 'e', datasetName: 'd', metadata: null };
const bodies = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)).map((c) => c.body);

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
describe('git provenance never reports a branch name as a commit', () => {
  it('a branch ref is exposed as ref only', () => {
    const meta = collectRunProvenance(undefined, {
      env: { TRACEROOT_GIT_REPO: 'owner/repo', TRACEROOT_GIT_REF: 'main' } as never,
      detectDirty: false,
    });
    assert.deepEqual(meta!.git, { repository: 'owner/repo', ref: 'main' });
  });

  it('a 40-hex ref is exposed as both ref and commit', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const meta = collectRunProvenance(undefined, {
      env: { TRACEROOT_GIT_REPO: 'owner/repo', TRACEROOT_GIT_REF: sha } as never,
      detectDirty: false,
    });
    assert.deepEqual(meta!.git, { repository: 'owner/repo', ref: sha, commit: sha });
  });

  it('a short hex-looking tag stays a ref', () => {
    const meta = collectRunProvenance(undefined, {
      env: { TRACEROOT_GIT_REPO: 'owner/repo', TRACEROOT_GIT_REF: 'deadbeef' } as never,
      detectDirty: false,
    });
    assert.deepEqual(meta!.git, { repository: 'owner/repo', ref: 'deadbeef' });
  });
});

// ---------------------------------------------------------------------------
describe('errored scorer keeps its declared version', () => {
  beforeEach(mockBackend);

  it('a versioned scorer that errored is not misattributed to unversioned', async () => {
    const t = transport({ scorerSpecs: [{ name: 'acc', version: 'v3' }] });
    await t.createRun('e', 'd', null);
    await t.recordItemResult(RUN, item({ scorerErrors: { acc: 'boom' } }));
    assert.equal(bodies('/results')[0].scores[0].scorer_version, 'v3');
  });

  it('an undeclared scorer still falls back to the sentinel', async () => {
    const t = transport({ scorerSpecs: [{ name: 'other', version: 'v3' }] });
    await t.createRun('e', 'd', null);
    await t.recordItemResult(RUN, item({ scorerErrors: { acc: 'boom' } }));
    assert.equal(bodies('/results')[0].scores[0].scorer_version, 'unversioned');
  });
});

// ---------------------------------------------------------------------------
describe('contract-cap clamping', () => {
  beforeEach(mockBackend);

  it('explanation is clamped with the marker', async () => {
    const t = transport();
    await t.createRun('e', 'd', null);
    await t.recordItemResult(
      RUN,
      item({ scores: [{ name: 'acc', value: 1, comment: 'x'.repeat(9000) } as never] }),
    );
    const expl = bodies('/results')[0].scores[0].explanation;
    assert.equal(expl.length, EXPLANATION_MAX);
    assert.ok(expl.endsWith(TRUNCATION_SUFFIX));
  });

  it('scorer error is clamped', async () => {
    const t = transport();
    await t.createRun('e', 'd', null);
    await t.recordItemResult(RUN, item({ scorerErrors: { acc: 'e'.repeat(9000) } }));
    const err = bodies('/results')[0].scores[0].error;
    assert.equal(err.length, SCORE_ERROR_MAX);
    assert.ok(err.endsWith(TRUNCATION_SUFFIX));
  });

  it('task error is clamped', async () => {
    const t = transport();
    await t.createRun('e', 'd', null);
    await t.recordItemResult(RUN, item({ error: 'b'.repeat(20000) }));
    const te = bodies('/results')[0].task_error;
    assert.equal(te.length, TASK_ERROR_MAX);
    assert.ok(te.endsWith(TRUNCATION_SUFFIX));
  });

  it('string value is clamped', async () => {
    const t = transport();
    await t.createRun('e', 'd', null);
    await t.recordItemResult(
      RUN,
      item({ scores: [{ name: 'label', value: 's'.repeat(5000) } as never] }),
    );
    const sv = bodies('/results')[0].scores[0].string_value;
    assert.equal(sv.length, STRING_VALUE_MAX);
    assert.ok(sv.endsWith(TRUNCATION_SUFFIX));
  });

  it('payload text fields are clamped', async () => {
    const t = transport();
    await t.createRun('e', 'd', null);
    const big = 'p'.repeat(PAYLOAD_TEXT_MAX + 10);
    await t.recordItemResult(RUN, item({ input: big, output: big, expected: big }));
    const body = bodies('/results')[0];
    for (const field of ['input', 'candidate_output', 'expected_output']) {
      assert.equal(body[field].length, PAYLOAD_TEXT_MAX);
      assert.ok(String(body[field]).endsWith(TRUNCATION_SUFFIX));
    }
  });

  it('under-cap values pass through untouched', async () => {
    const t = transport();
    await t.createRun('e', 'd', null);
    await t.recordItemResult(
      RUN,
      item({ error: 'short', scores: [{ name: 'acc', value: 1, comment: 'fine' } as never] }),
    );
    const body = bodies('/results')[0];
    assert.equal(body.task_error, 'short');
    assert.equal(body.scores[0].explanation, 'fine');
  });

  it('run metadata is clamped on registration', async () => {
    // Run metadata is free-form and user-supplied (a whole prompt, a config dump), and it is the
    // ONE field that reaches the backend unclamped. Over the cap, REGISTRATION 400s and the run
    // never starts — worse than any per-result rejection.
    const t = transport();
    await t.createRun('e', 'd', { prompt: 'm'.repeat(METADATA_MAX + 100) });
    const meta = bodies('/evaluation-runs')[0].metadata;
    assert.equal(meta.truncated, true);
    assert.ok(JSON.stringify(meta).length <= METADATA_MAX);
  });

  it('under-cap run metadata passes through untouched', async () => {
    const t = transport();
    await t.createRun('e', 'd', { commit: 'abc123' });
    assert.deepEqual(bodies('/evaluation-runs')[0].metadata, { commit: 'abc123' });
  });

  it('scorer source is clamped on registration', async () => {
    const t = transport({ scorerSpecs: [{ name: 'acc', source: 'c'.repeat(60000) }] });
    await t.createRun('e', 'd', null);
    const ref = bodies('/evaluation-runs')[0].scorers[0];
    assert.equal(ref.source.length, SCORER_SOURCE_MAX);
    assert.ok(ref.source.endsWith(TRUNCATION_SUFFIX));
  });
});

// ---------------------------------------------------------------------------
describe('HTTP calls are bounded', () => {
  it('default timeout matches the Python SDK', () => {
    assert.equal(HTTP_TIMEOUT_MS, 30_000);
  });

  it('a hung backend rejects via the abort signal instead of hanging the run', async () => {
    // AbortSignal.timeout() uses an UNREF'd timer, so the stub has to hold the event loop
    // open the way a real in-flight socket would.
    globalThis.fetch = ((_url: string, init?: any) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('never aborted')), 5_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        });
      })) as any;
    await assert.rejects(
      () => httpJson('GET', 'https://h/hang', 'tr-x', undefined, 20),
      (err: any) => err?.name === 'TimeoutError',
    );
  });

  it('an empty response body parses as an empty object', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as any;
    assert.deepEqual(await httpJson('POST', 'https://h/x', 'tr-x', {}), {});
  });
});

// ---------------------------------------------------------------------------
describe('single-scorer ownership does not fabricate a verdict', () => {
  beforeEach(mockBackend);

  it('a lone metric-map scorer does not stamp its threshold on every metric', async () => {
    const t = transport({
      scorerSpecs: [{ name: 'quality', threshold: 0.9, direction: 'higher_is_better' }],
    });
    await t.createRun('e', 'd', null);
    await t.recordItemResult(
      RUN,
      item({
        scores: [
          { name: 'accuracy', value: 0.95 } as never,
          { name: 'latency_ms', value: 120 } as never,
        ],
      }),
    );
    const scores = Object.fromEntries(
      bodies('/results')[0].scores.map((s: any) => [s.scorer_name, s]),
    );
    assert.ok(!('passed' in scores.accuracy)); // name doesn't match the declaration
    assert.ok(!('passed' in scores.latency_ms)); // 120 >= 0.9 must NOT become a pass
  });

  it('a matching metric name still gets its verdict', async () => {
    const t = transport({
      scorerSpecs: [{ name: 'quality', threshold: 0.9, direction: 'higher_is_better' }],
    });
    await t.createRun('e', 'd', null);
    await t.recordItemResult(
      RUN,
      item({
        scores: [
          { name: 'quality', value: 0.95 } as never,
          { name: 'latency_ms', value: 120 } as never,
        ],
      }),
    );
    const scores = Object.fromEntries(
      bodies('/results')[0].scores.map((s: any) => [s.scorer_name, s]),
    );
    assert.equal(scores.quality.passed, true);
    assert.ok(!('passed' in scores.latency_ms));
  });

  it('a lone metric keeps the name-agnostic shortcut', async () => {
    const t = transport({
      scorerSpecs: [{ name: 'grade', threshold: 0.9, direction: 'higher_is_better' }],
    });
    await t.createRun('e', 'd', null);
    await t.recordItemResult(RUN, item({ scores: [{ name: 'quality', value: 0.95 } as never] }));
    assert.equal(bodies('/results')[0].scores[0].passed, true);
  });
});

// ---------------------------------------------------------------------------
describe('summary() is byte-identical to Python', () => {
  it('quotes the name and renders means with %.4g', () => {
    const results: EvalItemResult[] = [
      item({ caseId: 'a', scores: [{ name: 'acc', value: 1 } as never] }),
      item({ caseId: 'b', scores: [{ name: 'acc', value: 0.5 } as never] }),
      item({ caseId: 'c', scores: [{ name: 'acc', value: 1 } as never] }),
    ];
    const run = makeRunResult('r', results, { status: 'uploaded', dashboardUrl: null });
    assert.equal(
      run.summary(),
      // Golden string captured from traceroot-py EvalRunResult.summary() on the same input.
      "EvalRunResult(name='r', cases=3, errored=0, not_scored=3, task_errors=0, upload=uploaded)\n" +
        '  acc: mean=0.8333 count=3',
    );
  });

  it('renders an integral mean without a trailing .0 and quotes an apostrophe name', () => {
    const results: EvalItemResult[] = [item({ scores: [{ name: 'acc', value: 120 } as never] })];
    const run = makeRunResult("it's", results, { status: 'uploaded', dashboardUrl: null });
    assert.equal(
      run.summary(),
      'EvalRunResult(name="it\'s", cases=1, errored=0, not_scored=1, task_errors=0, upload=uploaded)\n' +
        '  acc: mean=120 count=1',
    );
  });

  it('a double-quoted name keeps single-quote repr', () => {
    const results: EvalItemResult[] = [item({ scores: [{ name: 'acc', value: 120 } as never] })];
    const run = makeRunResult('"x', results, { status: 'uploaded', dashboardUrl: null });
    assert.match(run.summary(), /^EvalRunResult\(name='"x', /);
  });

  it('renders a small magnitude in Python exponent form', () => {
    const results: EvalItemResult[] = [item({ scores: [{ name: 'acc', value: 1e-5 } as never] })];
    const run = makeRunResult('r', results, { status: 'uploaded', dashboardUrl: null });
    assert.match(run.summary(), /acc: mean=1e-05 count=1/);
  });
});
