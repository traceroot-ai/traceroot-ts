// Phase 3: deterministic main-score / scorer-name resolution. Kills the footgun where a
// scorer whose function name differs from its emitted Score name silently resolved to
// not_scored. Parity with traceroot-py/tests/eval/test_main_score_resolution.py.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { PlatformTransport } from '../src/eval/platform';

const realFetch = globalThis.fetch;
let calls: { url: string; body: any }[] = [];

function mock() {
  process.env['TRACEROOT_API_KEY'] = 'tr-test';
  process.env['TRACEROOT_HOST_URL'] = 'https://h';
  process.env['TRACEROOT_ENABLED'] = 'false';
  globalThis.fetch = (async (url: string, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ evaluation_run_id: 'run_1' }), { status: 200 });
  }) as any;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_HOST_URL'];
  delete process.env['TRACEROOT_ENABLED'];
});

function item(scores: any[], error: string | null = null): any {
  return {
    caseId: 'c0', input: {}, output: {}, expected: null,
    scores, scorerErrors: {}, error, traceId: null, durationMs: null,
  };
}
const resultBody = () => calls.find((c) => c.url.endsWith('/results'))?.body;

describe('deterministic main-score resolution', () => {
  it('single scorer resolves name-agnostically (footgun fixed)', async () => {
    mock();
    const t = new PlatformTransport('ds', { scorerNames: ['grade'] });
    await t.createRun('e', 'd', null);
    await t.recordItemResult({} as any, item([{ name: 'quality', value: 0.9 }]));
    assert.equal(resultBody().main_score, 0.9);
    assert.notEqual(resultBody().status, 'not_scored');
  });

  it('explicit main matches by emitted metric name', async () => {
    mock();
    const t = new PlatformTransport('ds', { scorerNames: ['a', 'b'], mainScoreName: 'a' });
    await t.createRun('e', 'd', null);
    await t.recordItemResult(
      {} as any,
      item([{ name: 'a', value: 1.0 }, { name: 'b', value: 0.0 }]),
    );
    assert.equal(resultBody().main_score, 1.0);
  });

  it('explicit main never emitted fails loud at finish', async () => {
    mock();
    const t = new PlatformTransport('ds', { scorerNames: ['grade'], mainScoreName: 'grade' });
    await t.createRun('e', 'd', null);
    await t.recordItemResult({} as any, item([{ name: 'quality', value: 1.0 }]));
    await assert.rejects(() => t.finishRun({} as any), /never emitted/);
  });

  it('multiple scorers with no main have no headline metric', async () => {
    mock();
    const t = new PlatformTransport('ds', { scorerNames: ['a', 'b'] });
    await t.createRun('e', 'd', null);
    await t.recordItemResult(
      {} as any,
      item([{ name: 'a', value: 1.0 }, { name: 'b', value: 0.0 }]),
    );
    assert.equal(resultBody().main_score, null);
    assert.equal(resultBody().status, 'not_scored');
  });

  it('score array (single scorer) takes the first numeric', async () => {
    mock();
    const t = new PlatformTransport('ds', { scorerNames: ['multi'] });
    await t.createRun('e', 'd', null);
    await t.recordItemResult(
      {} as any,
      item([{ name: 'a', value: 0.7 }, { name: 'b', value: 0.2 }]),
    );
    assert.equal(resultBody().main_score, 0.7);
  });

  it('errored case is errored, not scored', async () => {
    mock();
    const t = new PlatformTransport('ds', { scorerNames: ['acc'] });
    await t.createRun('e', 'd', null);
    await t.recordItemResult({} as any, item([], 'boom'));
    assert.equal(resultBody().status, 'errored');
  });
});
