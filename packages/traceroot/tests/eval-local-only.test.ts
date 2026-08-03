// Phase 4: truthful local/cloud boundary. A local-only (non-reporting) runner run drops
// credentials (mirroring traceroot-py) so it can never silently upload eval results on
// ambient credentials, and makes zero network calls. Parity with the Python local-only tests.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Emitter, runSuite } from '../src/eval';
import { TraceRoot } from '../src/traceroot';

const realFetch = globalThis.fetch;
const evalDir = join(__dirname, '..', 'src', 'eval').replace(/\\/g, '/');

beforeEach(() => {
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_ENABLED'];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_ENABLED'];
});

describe('local-only network boundary', () => {
  it('_clearCredentials drops resolved credentials (no reporting transport can be built)', () => {
    process.env['TRACEROOT_API_KEY'] = 'tr-x';
    assert.notEqual(TraceRoot.resolveCredentials().apiKey, '');
    delete process.env['TRACEROOT_API_KEY'];
    TraceRoot._clearCredentials();
    assert.equal(TraceRoot.resolveCredentials().apiKey, '');
  });

  it('a local (non-reporting) run makes zero network calls even with ambient credentials', async () => {
    process.env['TRACEROOT_API_KEY'] = 'tr-ambient';
    let fetchCalls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls += 1;
      return (realFetch as any)(...args);
    }) as any;

    const dir = mkdtempSync(join(tmpdir(), 'localonly-'));
    const evalFile = join(dir, 'routing_eval.ts');
    writeFileSync(
      evalFile,
      `import { Dataset, Evaluation, FakeTransport } from '${evalDir}';
       const ds = new Dataset('t');
       ds.add({ m: 'charge' }, { id: 'a', expected: { r: 'billing' } });
       function task(x: any) { return { r: 'billing' }; }
       function acc(ctx: any) { return 1; }
       export const e = new Evaluation({ name: 'e', dataset: ds, task, scorers: [acc], transport: new FakeTransport() });`,
    );

    const events: Record<string, any>[] = [];
    await runSuite(
      [evalFile],
      { reporting: false, no_artifact: true },
      new Emitter((ln) => events.push(JSON.parse(ln))),
    );

    // Enforced local-only: TRACEROOT_ENABLED is off AND the ambient API key was dropped.
    assert.equal(fetchCalls, 0);
    assert.equal(process.env['TRACEROOT_ENABLED'], 'false');
    assert.equal(process.env['TRACEROOT_API_KEY'], undefined);
    assert.ok(events.some((e) => e.type === 'evaluation_completed'));
  });
});
