// A published dataset re-hashes to the revision that published it.
//
// `publishedRevision === snapshot.revision` is the single predicate the whole idempotent-push
// design rests on, and both suites used to stub it out wholesale. Here NOTHING in the SDK is
// stubbed except `fetch`: push -> the captured wire payload -> a version-shaped response ->
// pullDatasetVersion -> datasetFromVersion -> recomputed revision. If the value hashed is not the
// value sent, the second push publishes a no-change version and this fails.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Dataset, PlatformDatasetSync } from '../src/eval';

const realFetch = globalThis.fetch;

/** The three endpoints push/pull touch, backed by a Map. Every payload crosses a real
 *  JSON.stringify/parse so a value that cannot survive JSON fails here, not in production. */
class FakeBackend {
  versions = new Map<string, unknown>();
  current = new Map<string, string>();
  published = 0;

  install(): void {
    globalThis.fetch = (async (input: string, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const json = (value: unknown) => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(JSON.stringify(value)),
        text: async () => JSON.stringify(value),
      });

      if (method === 'GET' && path.includes('/dataset-versions/')) {
        return json(this.versions.get(path.split('/').pop() as string));
      }
      if (method === 'GET') {
        const datasetId = path.split('/').pop() as string;
        const current = this.current.get(datasetId);
        if (!current) {
          return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
        }
        return json({ name: 'rt', current_dataset_version_id: current });
      }
      if (path.endsWith('/versions')) {
        const datasetId = path.split('/datasets/')[1].split('/')[0];
        this.published += 1;
        const versionId = `dsv_${this.published}`;
        // Store what the SDK actually sent, through a real JSON round trip.
        const changes = JSON.parse(init?.body ?? '{}').changes;
        this.versions.set(versionId, {
          dataset_id: datasetId,
          dataset_version_id: versionId,
          version_number: this.published,
          items: changes,
        });
        this.current.set(datasetId, versionId);
        return json({ dataset_version_id: versionId, version_number: this.published });
      }
      return json({});
    }) as unknown as typeof fetch;
  }
}

function makeSync(): PlatformDatasetSync {
  const sync = Object.create(PlatformDatasetSync.prototype) as PlatformDatasetSync;
  (sync as unknown as { apiKey: string }).apiKey = 'k';
  (sync as unknown as { baseUrl: string }).baseUrl = 'https://h';
  return sync;
}

function makeDataset(): Dataset {
  const d = new Dataset('roundtrip');
  d.add(
    { when: new Date('2020-01-01T12:00:00.000Z'), tags: new Set(['b', 'a']) },
    {
      expected: { score: 1.0, eps: 1e-7 },
      metadata: { '10': 'x', '2': 'y', raw: Uint8Array.from([104, 105]) },
    },
  );
  d.add({ plain: 'case' });
  return d;
}

let backend: FakeBackend;

beforeEach(() => {
  backend = new FakeBackend();
  backend.install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('dataset push/pull round trip', () => {
  it('push then pull recomputes the same revision', async () => {
    const sync = makeSync();
    const snapshot = makeDataset().snapshot();
    await sync.pushDataset(snapshot, null);
    assert.equal(backend.published, 1);

    const [pulled, pulledNumber] = await (
      sync as unknown as {
        publishedRevision(d: string, v: string): Promise<[string | null, number | null]>;
      }
    ).publishedRevision(snapshot.datasetId, 'dsv_1');
    assert.equal(pulled, snapshot.revision);
    assert.equal(pulledNumber, 1);
  });

  it('a second push of unchanged content is a no-op and never prompts', async () => {
    // The user-visible consequence: a Date/Set/typed-array case used to publish a brand-new
    // version on every push, unprompted-and-unbounded, because the pull never matched.
    const sync = makeSync();
    const refuse = () => {
      throw new Error('unchanged content must not prompt');
    };
    await sync.pushDataset(makeDataset().snapshot(), null, { onExisting: refuse });
    const result = await sync.pushDataset(makeDataset().snapshot(), null, { onExisting: refuse });

    assert.equal(backend.published, 1); // no second version
    assert.equal(result.datasetVersionId, 'dsv_1');
    // The no-op reports the version it KEPT, not a blank: a caller re-pushing unchanged content
    // sees the same versionNumber the original push returned.
    assert.equal(result.versionNumber, 1);
  });

  it('the wire payload is the canonical form that was hashed', async () => {
    const sync = makeSync();
    await sync.pushDataset(makeDataset().snapshot(), null);
    type Item = { input: Record<string, unknown>; metadata: Record<string, unknown> };
    const { items } = backend.versions.get('dsv_1') as { items: Item[] };
    const sent = items.find((i) => 'when' in i.input) as Item;
    assert.deepEqual(sent.input, { when: '2020-01-01T12:00:00.000Z', tags: ['a', 'b'] });
    assert.deepEqual(sent.metadata.raw, [104, 105]);
  });

  it('save/load round trip preserves the revision', () => {
    // Same invariant on the local persistence path: a reloaded dataset must not look edited.
    const local = makeDataset();
    const path = join(mkdtempSync(join(tmpdir(), 'traceroot-eval-')), 'ds.json');
    local.save(path);
    assert.equal(Dataset.load(path).snapshot().revision, local.snapshot().revision);
  });
});
