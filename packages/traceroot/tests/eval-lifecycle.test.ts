// Parity: dataset authoring/snapshot/save-load + push seam (LocalDatasetSync / FakeDatasetSync
// / conflict) + ULID ids.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Dataset,
  FakeDatasetSync,
  LocalDatasetSync,
  DatasetConflictError,
  newRunId,
  newDatasetId,
} from '../src/eval';
import { TraceRoot } from '../src/traceroot';

describe('ids', () => {
  it('typed ULID ids, time-sortable-ish and unique', () => {
    assert.match(newDatasetId(), /^ds_[0-9A-Z]{26}$/);
    assert.match(newRunId(), /^run_[0-9A-Z]{26}$/);
    assert.notEqual(newRunId(), newRunId());
  });
});

describe('Dataset authoring + snapshot', () => {
  it('add/update/archive/remove + active vs archived', () => {
    const ds = new Dataset('d', 'desc');
    ds.add({ q: 1 } as unknown, { id: 'c0', expected: 1 });
    assert.throws(() => ds.add(2, { id: 'c0' }), /already exists/);
    ds.add(2, { id: 'c1' });
    ds.update('c1', { expected: 99 });
    assert.equal(ds.get('c1')!.expected, 99);
    ds.archive('c0');
    assert.equal(ds.size, 1); // c0 archived -> excluded from active
    assert.equal(ds.cases(true).length, 2);
    ds.remove('c1');
    assert.equal(ds.size, 0);
  });

  it('snapshot revision is content-addressed and stable', () => {
    const mk = () => {
      const d = new Dataset('d');
      d.add({ m: 'x' }, { id: 'a', expected: 1 });
      return d;
    };
    assert.equal(mk().snapshot().revision, mk().snapshot().revision);
    assert.match(mk().snapshot().revision, /^rev_[0-9a-f]{16}$/);
  });

  it('save/load round-trips metadata, archived cases, and value types (.json and .jsonl)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const ds = new Dataset('tickets', 'd');
    ds.add(
      { m: 'hi', n: 2, ok: true },
      { id: 'a', expected: { r: 'billing' }, metadata: { s: 1 } },
    );
    ds.add({ m: 'bye' }, { id: 'b' });
    ds.archive('b'); // archived cases are retained for lineage and must persist
    for (const ext of ['json', 'jsonl']) {
      const p = join(dir, `ds.${ext}`);
      ds.save(p);
      const loaded = Dataset.load(p);
      assert.equal(loaded.name, 'tickets');
      // number/boolean types survive the JSON round-trip (not coerced to strings).
      assert.deepEqual(loaded.get('a')!.input, { m: 'hi', n: 2, ok: true });
      assert.deepEqual(loaded.get('a')!.expected, { r: 'billing' });
      assert.deepEqual(loaded.get('a')!.metadata, { s: 1 }); // metadata preserved
      assert.ok(loaded.get('b')?.archived, 'archived case must round-trip');
    }
  });
});

describe('push seam', () => {
  it('LocalDatasetSync stays local', async () => {
    const ds = new Dataset('d');
    ds.add(1, { id: 'a' });
    const r = await ds.push(new LocalDatasetSync());
    assert.equal(r.status, 'local_only');
    assert.equal(ds.datasetVersionId, undefined);
  });

  it('bare push() without credentials rejects (parity with Python)', async () => {
    // push() publishes to the platform by default; with no credentials it must reject with an
    // actionable error rather than silently stay local.
    const orig = TraceRoot.resolveCredentials;
    (TraceRoot as { resolveCredentials: typeof TraceRoot.resolveCredentials }).resolveCredentials =
      () => ({ apiKey: '', baseUrl: 'http://localhost' });
    try {
      const ds = new Dataset('d');
      ds.add(1, { id: 'a' });
      await assert.rejects(() => ds.push(), /publishes to the TraceRoot platform/);
    } finally {
      (
        TraceRoot as { resolveCredentials: typeof TraceRoot.resolveCredentials }
      ).resolveCredentials = orig;
    }
  });

  it('bare push() WITH credentials publishes to the platform', async () => {
    // The other half of the default: a credentialed bare push() must route to
    // PlatformDatasetSync and actually write. Without this, a regression restoring the old
    // local-only default would still pass the rejects-without-credentials test above.
    const realFetch = globalThis.fetch;
    const calls: { method: string; url: string }[] = [];
    process.env['TRACEROOT_API_KEY'] = 'tr-test';
    process.env['TRACEROOT_HOST_URL'] = 'https://h';
    globalThis.fetch = (async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      const u = String(url);
      calls.push({ method, url: u });
      // The dataset does not exist yet: only a 404 means "new", so no prompt and no
      // publishedRevision round trip.
      if (method === 'GET') return new Response('no such dataset', { status: 404 });
      if (u.endsWith('/versions'))
        return new Response(JSON.stringify({ dataset_version_id: 'dsv_1', version_number: 1 }), {
          status: 200,
        });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const ds = new Dataset('d');
      ds.add(1, { id: 'a' });
      const r = await ds.push();
      assert.equal(r.status, 'uploaded');
      assert.equal(r.datasetVersionId, 'dsv_1');
      assert.equal(ds.datasetVersionId, 'dsv_1'); // the push advanced the pinned version
      assert.ok(
        calls.some((c) => c.method === 'POST' && c.url === `https://h/api/v1/public/datasets`),
        'bare push() must upsert the dataset on the platform',
      );
      assert.ok(
        calls.some((c) => c.method === 'POST' && c.url.endsWith(`/${ds.datasetId}/versions`)),
        'bare push() must publish a version on the platform',
      );
    } finally {
      globalThis.fetch = realFetch;
      delete process.env['TRACEROOT_API_KEY'];
      delete process.env['TRACEROOT_HOST_URL'];
    }
  });

  it('FakeDatasetSync versions, idempotency, and conflict', async () => {
    const sync = new FakeDatasetSync();
    const ds = new Dataset('d');
    ds.add(1, { id: 'a' });
    const v1 = await ds.push(sync);
    assert.equal(v1.status, 'uploaded');
    assert.equal(ds.datasetVersionId, v1.datasetVersionId); // pinned
    // idempotent re-push of unchanged content -> same version
    const again = await ds.push(sync, v1.datasetVersionId);
    assert.equal(again.datasetVersionId, v1.datasetVersionId);
    // a stale base rejects
    sync.forceCurrentVersion('dsv_99');
    await assert.rejects(() => ds.push(sync, 'dsv_stale'), DatasetConflictError);
  });
});

// --- Existing-dataset confirmation on push (parity with test_dataset_sync.py) ---------------
import { PlatformDatasetSync, DatasetPublishAborted } from '../src/eval';
import { confirmNewVersion } from '../src/eval/dataset_sync';
import { PassThrough } from 'node:stream';

function mockPlatformSync(exists: boolean, publishedRev: string | null = 'rev_different') {
  const sync = Object.create(PlatformDatasetSync.prototype) as PlatformDatasetSync & {
    calls: string[];
  };
  (sync as unknown as { apiKey: string }).apiKey = 'k';
  (sync as unknown as { baseUrl: string }).baseUrl = 'https://h';
  (sync as unknown as { calls: string[] }).calls = [];
  (sync as unknown as { request: unknown }).request = async (method: string, path: string) => {
    (sync as unknown as { calls: string[] }).calls.push(`${method} ${path}`);
    if (method === 'GET') {
      if (exists) return { name: 'd', current_dataset_version_id: 'dsv_9' };
      throw new Error('GET .../datasets/x -> HTTP 404: not found');
    }
    if (path.endsWith('/versions')) return { dataset_version_id: 'dsv_10', version_number: 2 };
    return {};
  };
  // Stub the published-revision fetch: `publishedRev` drives changed-vs-unchanged detection.
  (sync as unknown as { publishedRevision: unknown }).publishedRevision = async () => publishedRev;
  return sync;
}

function snap() {
  const d = new Dataset('d');
  d.add({ q: 'a' });
  return d.snapshot();
}

describe('existing-dataset confirmation on push (TS)', () => {
  it('unchanged content is a no-op without prompting', async () => {
    const s = snap();
    const sync = mockPlatformSync(true, s.revision) as PlatformDatasetSync & { calls: string[] };
    let called = false;
    const res = await sync.pushDataset(s, null, {
      onExisting: () => {
        called = true;
        return true;
      },
    });
    assert.equal(res.datasetVersionId, 'dsv_9'); // reuses the current version
    assert.equal(called, false); // unchanged -> never prompts
    assert.ok(!sync.calls.some((c) => c.endsWith('/versions'))); // no new version published
  });

  it('declined publish to an existing (changed) dataset aborts without creating a version', async () => {
    const sync = mockPlatformSync(true) as PlatformDatasetSync & { calls: string[] };
    await assert.rejects(
      () => sync.pushDataset(snap(), null, { onExisting: () => false }),
      DatasetPublishAborted,
    );
    assert.ok(!sync.calls.some((c) => c.endsWith('/versions'))); // no version was published
  });

  it('accepted publish to an existing dataset creates a new version', async () => {
    const sync = mockPlatformSync(true) as PlatformDatasetSync & { calls: string[] };
    const res = await sync.pushDataset(snap(), null, { onExisting: () => true });
    assert.equal(res.datasetVersionId, 'dsv_10');
  });

  it('a brand-new dataset never prompts', async () => {
    let called = false;
    const sync = mockPlatformSync(false);
    await sync.pushDataset(snap(), null, {
      onExisting: () => {
        called = true;
        return true;
      },
    });
    assert.equal(called, false); // 404 -> new -> confirmation never invoked
  });

  it('default confirmer proceeds when non-interactive (no TTY)', async () => {
    const sync = mockPlatformSync(true); // existing, but no onExisting -> default confirmer
    const res = await sync.pushDataset(snap(), null); // process.stdin.isTTY is falsy in the test env
    assert.equal(res.datasetVersionId, 'dsv_10');
  });

  it('default confirmer declines on EOF at the prompt', async () => {
    // The prompt defaults to NO; EOF is no answer at all, so it must decline too. Answering
    // "yes" to a question nobody read is exactly the accidental publish the prompt prevents.
    delete process.env['TRACEROOT_ASSUME_YES'];
    const { accepted } = await atThePrompt(null);
    assert.equal(accepted, false);
  });

  // Drive confirmNewVersion through its ACTUAL readline path on a fake TTY (every other
  // confirmation test injects onExisting and never exercises the prompt itself). `typed === null`
  // is EOF (^D / a stream that closes unanswered). Returns whatever was written to the prompt
  // stream so a test can assert the prompt was — or was not — shown.
  async function atThePrompt(typed: string | null) {
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const output = new PassThrough();
    let prompt = '';
    output.on('data', (chunk) => {
      prompt += String(chunk);
    });
    const answered = confirmNewVersion(
      { name: 'd', current_dataset_version_id: 'dsv_9' },
      input as unknown as NodeJS.ReadStream,
      output,
    );
    input.end(typed === null ? undefined : `${typed}\n`);
    return { accepted: await answered, prompt };
  }

  const ANSWERS: [string, boolean][] = [
    ['', false], // a bare Enter is the [y/N] default: decline
    ['n', false],
    ['N', false],
    ['no', false],
    ['garbage', false], // anything that isn't yes is not a yes
    ['y', true],
    ['Y', true],
    ['YES', true], // case-insensitive
    ['  y  ', true], // surrounding whitespace is trimmed
  ];
  for (const [typed, accepted] of ANSWERS) {
    it(`typed answer ${JSON.stringify(typed)} -> ${accepted ? 'publish' : 'decline'}`, async () => {
      delete process.env['TRACEROOT_ASSUME_YES'];
      const res = await atThePrompt(typed);
      assert.equal(res.accepted, accepted);
      assert.ok(res.prompt.includes('[y/N]')); // the prompt was actually shown
    });
  }

  it('TRACEROOT_ASSUME_YES publishes without ever prompting', async () => {
    // The documented escape hatch must SKIP the prompt entirely — not read stdin and override it —
    // so it holds on an interactive terminal whose next keystroke would decline.
    process.env['TRACEROOT_ASSUME_YES'] = '1';
    try {
      const res = await atThePrompt('n'); // a TTY that would say no
      assert.equal(res.accepted, true);
      assert.equal(res.prompt, ''); // stdin was never consulted
    } finally {
      delete process.env['TRACEROOT_ASSUME_YES'];
    }
  });

  for (const value of ['1', 'true', 'YES', ' yes ']) {
    it(`TRACEROOT_ASSUME_YES=${JSON.stringify(value)} arms the bypass`, async () => {
      process.env['TRACEROOT_ASSUME_YES'] = value;
      try {
        assert.equal((await atThePrompt('n')).accepted, true);
      } finally {
        delete process.env['TRACEROOT_ASSUME_YES'];
      }
    });
  }

  for (const value of ['0', 'false', 'no', '']) {
    it(`TRACEROOT_ASSUME_YES=${JSON.stringify(value)} still honours the prompt`, async () => {
      // An unset-like value must not silently arm the bypass: the TTY's "n" still decides.
      process.env['TRACEROOT_ASSUME_YES'] = value;
      try {
        assert.equal((await atThePrompt('n')).accepted, false);
      } finally {
        delete process.env['TRACEROOT_ASSUME_YES'];
      }
    });
  }

  it('TRACEROOT_ASSUME_YES publishes a new version end to end', async () => {
    // The bypass must reach the real push: an existing dataset with changed content publishes,
    // through the DEFAULT confirmer, against a TTY that would have declined.
    process.env['TRACEROOT_ASSUME_YES'] = '1';
    try {
      const input = new PassThrough();
      (input as unknown as { isTTY: boolean }).isTTY = true;
      input.end('n\n');
      const output = new PassThrough();
      let prompt = '';
      output.on('data', (chunk) => {
        prompt += String(chunk);
      });
      const sync = mockPlatformSync(true) as PlatformDatasetSync & { calls: string[] };
      const res = await sync.pushDataset(snap(), null, {
        onExisting: (info) =>
          confirmNewVersion(info, input as unknown as NodeJS.ReadStream, output),
      });
      assert.equal(res.datasetVersionId, 'dsv_10');
      assert.ok(sync.calls.some((c) => c.endsWith('/versions')));
      assert.equal(prompt, ''); // never asked
    } finally {
      delete process.env['TRACEROOT_ASSUME_YES'];
    }
  });
});
