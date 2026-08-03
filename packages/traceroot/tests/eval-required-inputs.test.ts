// the extensible required_inputs scorer descriptor (replaces the never-shipped
// reference_based boolean). Declared for code scorers, derived from template placeholders
// for llmJudge, unknown (omitted) for a bare callable. Parity with
// traceroot-py/tests/eval/test_required_inputs.py.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { scorer, llmJudge, scorerMetadata, describeScorers } from '../src/eval';
import { PlatformTransport } from '../src/eval/platform';

describe('required_inputs descriptor', () => {
  it('code scorer declares required_inputs', () => {
    const hasConclusion = scorer(() => 1.0, { valueType: 'numeric', requiredInputs: ['output'] });
    assert.deepEqual(scorerMetadata(hasConclusion).required_inputs, ['output']);
  });

  it('bare callable is unknown (omitted)', () => {
    const plain = () => 1.0;
    assert.equal('required_inputs' in scorerMetadata(plain), false);
  });

  it('decorated scorer without declaration is unknown', () => {
    const acc = scorer(() => 1.0, { valueType: 'numeric' });
    assert.equal('required_inputs' in scorerMetadata(acc), false);
  });

  it('llmJudge derives output-only from placeholders (never requires expected)', () => {
    const judge = llmJudge({
      name: 'no_conclusion',
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'Grade whether the answer has a conclusion.' },
        { role: 'user', content: 'ANSWER:\n{{output}}' },
      ],
      complete: async () => '1.0',
    });
    assert.deepEqual(scorerMetadata(judge).required_inputs, ['output']);
  });

  it('llmJudge derives inputs in canonical order', () => {
    const judge = llmJudge({
      name: 'match',
      model: 'm',
      messages: [{ role: 'user', content: '{{expected}} vs {{output}} for {{input}}' }],
      complete: async () => '1',
    });
    assert.deepEqual(scorerMetadata(judge).required_inputs, ['input', 'output', 'expected']);
  });

  it('llmJudge explicit override wins', () => {
    const judge = llmJudge({
      name: 'j',
      model: 'm',
      messages: [{ role: 'user', content: '{{output}}' }],
      requiredInputs: ['input', 'output'],
      complete: async () => '1',
    });
    assert.deepEqual(scorerMetadata(judge).required_inputs, ['input', 'output']);
  });

  it('rejects an unknown required input', () => {
    assert.throws(() => scorer(() => 1.0, { requiredInputs: ['bogus'] }));
    assert.throws(() =>
      llmJudge({
        name: 'j',
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        requiredInputs: ['nope'],
        complete: async () => '1',
      }),
    );
  });
});

const realFetch = globalThis.fetch;
let calls: { url: string; body: any }[] = [];

function mockRegister() {
  process.env['TRACEROOT_API_KEY'] = 'tr-test';
  process.env['TRACEROOT_HOST_URL'] = 'https://h';
  process.env['TRACEROOT_ENABLED'] = 'false';
  globalThis.fetch = (async (url: string, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ evaluation_run_id: 'run_1' }), { status: 200 });
  }) as any;
}

describe('required_inputs on the wire', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env['TRACEROOT_API_KEY'];
    delete process.env['TRACEROOT_HOST_URL'];
    delete process.env['TRACEROOT_ENABLED'];
  });

  it('serializes required_inputs in the registration scorers[]', async () => {
    mockRegister();
    const hasConclusion = scorer(() => 1.0, { valueType: 'numeric', requiredInputs: ['output'] });
    const t = new PlatformTransport('ds', { scorerSpecs: describeScorers([hasConclusion]) });
    await t.createRun('eval', 'ds', null);
    const reg = calls.find((c) => c.url.endsWith('/evaluation-runs'));
    assert.ok(reg);
    assert.deepEqual(reg!.body.scorers[0].required_inputs, ['output']);
  });
});
