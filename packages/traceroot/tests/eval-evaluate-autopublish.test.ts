// evaluate()'s auto-publish must never stop to ask.
//
// A versioning decision cannot gate an eval run. When a locally-authored Dataset already exists on
// the platform and its content CHANGED, evaluate() publishes the new version silently, so the run
// pins exactly what it scored. The explicit, user-initiated Dataset.push() KEEPS the confirmation —
// that is where deliberate version management lives. Unchanged content is an idempotent no-op on
// both paths. Parity with traceroot-py/tests/eval/test_evaluate_autopublish.py.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { Dataset, evaluate, PlatformDatasetSync } from '../src/eval';
import type { ScorerContext } from '../src/eval';

const realFetch = globalThis.fetch;
const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);

function makeDataset(): Dataset {
  const d = new Dataset('auto');
  d.add({ m: 1 }, { id: 'c0', expected: { m: 1 } });
  return d;
}

/**
 * Stand in for an interactive terminal that gives NO answer (^D / a closed stream), which is what
 * the default confirmer treats as "no". Reaching the prompt at all is the failure this pins: on a
 * real TTY the run would sit there waiting for [y/N] instead.
 */
function installDecliningTty(): void {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  (stdin as unknown as PassThrough).end();
}

/**
 * A backend where the dataset ALREADY exists at `dsv_9`. `sameContent` decides whether the
 * published version matches what is about to be evaluated: false makes this a real content change
 * (the branch that confirms), true makes it the idempotent no-op.
 */
function installEvalBackend(sameContent: boolean): { versions: number } {
  process.env['TRACEROOT_API_KEY'] = 'tr-test';
  process.env['TRACEROOT_HOST_URL'] = 'https://h';
  process.env['TRACEROOT_ENABLED'] = 'false';
  const counts = { versions: 0 };
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (method === 'GET' && /\/datasets\/[^/]+$/.test(u))
      return ok({ name: 'auto', key: 'auto', current_dataset_version_id: 'dsv_9' });
    if (method === 'GET' && u.includes('/dataset-versions/')) {
      // Anything but the exact published content is a change; an unfetchable version is also
      // treated as changed (the SDK confirms rather than assuming unchanged).
      if (!sameContent) return new Response('boom', { status: 500 });
      return ok({
        dataset_id: makeDataset().datasetId,
        dataset_version_id: 'dsv_9',
        items: [{ test_case_id: 'c0', input: { m: 1 }, expected: { m: 1 } }],
      });
    }
    if (u.endsWith('/versions')) {
      counts.versions += 1;
      return ok({ dataset_version_id: 'dsv_10', version_number: 2 });
    }
    if (u.endsWith('/evaluation-runs')) return ok({ evaluation_run_id: 'run_1' });
    return ok({});
  }) as any;
  return counts;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(process, 'stdin', realStdin);
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_HOST_URL'];
  delete process.env['TRACEROOT_ENABLED'];
});

describe('evaluate() never prompts', () => {
  it('publishes a changed existing dataset without asking', async () => {
    const counts = installEvalBackend(false);
    installDecliningTty();
    const ds = makeDataset();

    const result = await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });

    assert.equal(counts.versions, 1, 'the changed content must really be versioned');
    assert.equal(ds.datasetVersionId, 'dsv_10');
    assert.equal(ds.baseVersionId, 'dsv_10');
    // The run pins exactly what it scored: the version the auto-publish just created.
    assert.equal(result.dataset.datasetVersionId, 'dsv_10');
  });

  it('is a silent no-op when the content is unchanged', async () => {
    const counts = installEvalBackend(true);
    installDecliningTty();
    const ds = makeDataset();

    const result = await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });

    assert.equal(counts.versions, 0, 'identical content must not add a version');
    assert.equal(result.dataset.datasetVersionId, 'dsv_9');
  });
});

describe('an explicit push still confirms', () => {
  // The deliberate publish boundary is unchanged: a direct push() asks, and a decline aborts
  // without touching the remote.
  it('a declined push aborts', async () => {
    const counts = installEvalBackend(false);
    installDecliningTty();
    await assert.rejects(() => makeDataset().push(new PlatformDatasetSync()), /declined/);
    assert.equal(counts.versions, 0);
  });

  it('an explicitly approved push publishes', async () => {
    installEvalBackend(false);
    installDecliningTty();
    const ds = makeDataset();
    let asked = 0;
    const res = await ds.push(new PlatformDatasetSync(), undefined, {
      onExisting: () => {
        asked += 1;
        return true;
      },
    });
    assert.equal(asked, 1);
    assert.equal(res.datasetVersionId, 'dsv_10');
  });

  it('unchanged content never asks', async () => {
    const counts = installEvalBackend(true);
    installDecliningTty();
    const res = await makeDataset().push(new PlatformDatasetSync());
    assert.equal(res.datasetVersionId, 'dsv_9');
    assert.equal(counts.versions, 0);
  });
});
