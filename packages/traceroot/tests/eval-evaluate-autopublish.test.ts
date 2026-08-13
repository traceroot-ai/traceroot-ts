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
import { rememberPinnedContent } from '../src/eval/platform';

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

describe('an auto-publish failure is actionable', () => {
  // The auto-publish happens BEFORE the first case runs, so anything it throws aborts the whole
  // evaluation. A raw conflict (or a timeout) reads as an SDK crash; it must read as the thing
  // that actually happened, with the way out.
  /** A backend where the dataset exists but publishing it fails with `status`. */
  function installFailingPublish(status: number, detail: string): void {
    process.env['TRACEROOT_API_KEY'] = 'tr-test';
    process.env['TRACEROOT_HOST_URL'] = 'https://h';
    process.env['TRACEROOT_ENABLED'] = 'false';
    globalThis.fetch = (async (url: string, init?: any) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/datasets\/[^/]+$/.test(u))
        return new Response(JSON.stringify({ name: 'auto', current_dataset_version_id: 'dsv_9' }), {
          status: 200,
        });
      if (method === 'GET' && u.includes('/dataset-versions/'))
        return new Response('boom', { status: 500 }); // unfetchable -> treated as changed
      if (u.endsWith('/versions')) return new Response(detail, { status });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as any;
  }

  it('reports a diverged remote instead of throwing the raw conflict', async () => {
    installFailingPublish(409, JSON.stringify({ current_version_id: 'dsv_77' }));
    await assert.rejects(
      () => evaluate({ name: 'r', dataset: makeDataset(), task: echo, scorers: [exact] }),
      (err: Error) => {
        assert.equal(err.name, 'Error'); // not a bare DatasetConflictError
        assert.match(err.message, /could not auto-publish dataset 'auto' before the run/);
        assert.match(err.message, /dataset changed remotely/); // the real reason is kept
        assert.match(err.message, /Pull the latest version/);
        assert.match(err.message, /local: true/); // ...and a way to run anyway
        return true;
      },
    );
  });

  it('reports a transport failure the same way', async () => {
    installFailingPublish(503, 'upstream down');
    await assert.rejects(
      () => evaluate({ name: 'r', dataset: makeDataset(), task: echo, scorers: [exact] }),
      /could not auto-publish dataset 'auto' before the run: .*HTTP 503/s,
    );
  });
});

describe('the run pins what it scored', () => {
  // A Dataset is mutable and evaluate() is re-runnable, so the version a run pins has to be
  // re-resolved every time. Pinning the version from a PREVIOUS run would attribute the new
  // cases' scores to content that never contained them.
  it('a second run after a mutation pins the new version', async () => {
    const counts = installEvalBackend(false);
    const ds = makeDataset();

    const first = await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });
    assert.equal(first.dataset.datasetVersionId, 'dsv_10');

    ds.add({ m: 2 }, { id: 'c1', expected: { m: 2 } }); // what the SECOND run actually scores
    const second = await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });

    assert.equal(counts.versions, 2, 'the mutated content must be versioned again');
    assert.equal(second.dataset.datasetVersionId, 'dsv_10');
  });

  it('an unmutated second run never re-versions', async () => {
    const counts = installEvalBackend(false);
    const ds = makeDataset();

    await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });
    const second = await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });

    assert.equal(counts.versions, 1, 'unchanged content must not add a version');
    assert.equal(second.dataset.datasetVersionId, 'dsv_10');
  });

  it('a pulled dataset mutated before its first run is republished', async () => {
    const counts = installEvalBackend(false);
    const ds = makeDataset();
    ds.datasetVersionId = 'dsv_pulled';
    rememberPinnedContent(ds); // exactly what pullDataset records
    ds.add({ m: 3 }, { id: 'c3', expected: { m: 3 } });

    const result = await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });

    assert.equal(counts.versions, 1);
    assert.equal(result.dataset.datasetVersionId, 'dsv_10'); // the version with the new case
  });

  it('a dataset pinned by hand is left alone', async () => {
    // No record of how it got its version -> no evidence of drift -> no surprise republish.
    const counts = installEvalBackend(true);
    const ds = makeDataset();
    ds.datasetVersionId = 'dsv_9';

    const result = await evaluate({ name: 'r', dataset: ds, task: echo, scorers: [exact] });

    assert.equal(counts.versions, 0);
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
