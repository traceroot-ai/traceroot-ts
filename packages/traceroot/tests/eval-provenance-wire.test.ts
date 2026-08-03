// structured run provenance is built in the backend's flat wire shape and
// reported at registration (git/CI/SDK identity + free-form metadata, honest omission).
// Parity with traceroot-py/tests/eval/test_provenance_wire.py.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runProvenance } from '../src/eval';
import { PlatformTransport } from '../src/eval/platform';

const realFetch = globalThis.fetch;
let calls: { method: string; url: string; body: any }[] = [];

function mockRegister() {
  process.env['TRACEROOT_API_KEY'] = 'tr-test';
  process.env['TRACEROOT_HOST_URL'] = 'https://h';
  process.env['TRACEROOT_ENABLED'] = 'false';
  globalThis.fetch = (async (url: string, init?: any) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
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

describe('runProvenance (flat wire shape)', () => {
  it('reports branch/CI/SDK identity; git_ref is the branch, not the commit SHA', () => {
    const prov = runProvenance({
      env: { GITHUB_REF_NAME: 'main', GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42' } as any,
      detectDirty: false,
    });
    assert.equal(prov.sdk_language, 'typescript');
    assert.equal(typeof prov.sdk_version, 'string');
    assert.equal(prov.git_ref, 'main');
    if ('git_commit' in prov) assert.notEqual(prov.git_ref, prov.git_commit);
    assert.equal(prov.ci_provider, 'github');
    assert.equal(prov.ci_build_id, '42');
    assert.equal('git_dirty' in prov, false); // not requested -> omitted, never null-filled
    assert.equal('declared_model' in prov, false); // model/prompt never auto-inferred
    assert.equal('declared_prompt_version' in prov, false);
  });

  it('reports SDK identity even without a CI signal', () => {
    const prov = runProvenance({ env: { PATH: '/usr/bin' } as any, detectDirty: false });
    assert.equal(prov.sdk_language, 'typescript');
    assert.equal('ci_provider' in prov, false);
  });
});

describe('createRun registration body', () => {
  it('reports typed provenance and free-form metadata', async () => {
    mockRegister();
    const t = new PlatformTransport('ds_1');
    await t.createRun('eval', 'ds', { team: 'quality' }, 'crun_1', {
      sdk_language: 'typescript',
      git_commit: 'abc',
    });
    const reg = calls.find((c) => c.url.endsWith('/evaluation-runs'));
    assert.ok(reg);
    assert.deepEqual(reg!.body.provenance, { sdk_language: 'typescript', git_commit: 'abc' });
    assert.deepEqual(reg!.body.metadata, { team: 'quality' });
    assert.equal(reg!.body.client_run_id, 'crun_1');
    assert.ok(reg!.url.endsWith('/api/v1/public/evaluation-runs'));
  });

  it('omits absent provenance and metadata (absent, not null-filled)', async () => {
    mockRegister();
    const t = new PlatformTransport('ds_1');
    await t.createRun('eval', 'ds', null, undefined, undefined);
    const reg = calls.find((c) => c.url.endsWith('/evaluation-runs'));
    assert.ok(reg);
    assert.equal('provenance' in reg!.body, false);
    assert.equal('metadata' in reg!.body, false);
  });
});
