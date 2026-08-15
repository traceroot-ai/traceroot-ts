// src/eval/dataset_sync.ts — explicit dataset publication seam (parity with
// traceroot-py/traceroot/eval/dataset_sync.py).
//
// One explicit Dataset.push() = one immutable server dataset version, with
// optimistic-concurrency conflict detection (baseVersionId). Local mutations never create
// versions. Default LocalDatasetSync is local-only; FakeDatasetSync drives tests;
// PlatformDatasetSync publishes to POST /api/v1/public/datasets + .../{id}/versions.

import { TraceRoot } from '../traceroot';
import { normalize } from './canonical';
import { httpJson, pullDatasetVersion } from './platform';
import type { DatasetSnapshot } from './types';

export class DatasetConflictError extends Error {
  constructor(
    readonly baseVersionId: string | null,
    readonly currentVersionId: string | null,
  ) {
    super(
      `dataset changed remotely: base=${JSON.stringify(baseVersionId)} ` +
        `current=${JSON.stringify(currentVersionId)}. Pull the latest version, review the ` +
        `diff, and retry intentionally.`,
    );
    this.name = 'DatasetConflictError';
  }
}

/** Thrown when publishing a new version to an ALREADY-EXISTING dataset is declined at the
 *  confirmation step (the push is a no-op: no version was created). */
export class DatasetPublishAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetPublishAborted';
  }
}

export interface ExistingDatasetInfo {
  name?: string;
  current_dataset_version_id?: string | null;
}

/** Called when a push targets an already-existing dataset; return false to abort. */
export type OnExisting = (info: ExistingDatasetInfo) => boolean | Promise<boolean>;

/** Default double-check before adding a version to an EXISTING dataset. A dataset's identity is its
 *  name, so re-pushing the same name updates the SAME dataset with a NEW version — usually intended,
 *  but easy to do by accident with a reused name. On an interactive TTY we ask first (default `no`,
 *  so neither an accidental Enter nor an EOF ever publishes); non-interactive contexts (CI, pipes)
 *  proceed silently, and `TRACEROOT_ASSUME_YES=1` skips the prompt everywhere. Mirrors Python
 *  `_confirm_new_version`. The streams are injectable so the prompt itself is testable. */
export async function confirmNewVersion(
  info: ExistingDatasetInfo,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const yes = new Set(['1', 'true', 'yes']);
  if (yes.has((process.env.TRACEROOT_ASSUME_YES ?? '').trim().toLowerCase())) return true;
  if (!input.isTTY) return true;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input, output });
  try {
    const name = info.name ?? '?';
    const ver = info.current_dataset_version_id ?? null;
    // EOF (^D) or a stream that closes under us is NO answer at all, so it declines like a bare
    // Enter — an unread prompt must never publish (parity with Python's EOFError branch).
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    const ans = await Promise.race([
      rl.question(
        `Dataset '${name}' already exists (current version ${ver}). Publish a NEW version? [y/N] `,
      ),
      closed,
    ]);
    return ans === null ? false : ['y', 'yes'].includes(ans.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

/** Outcome of Dataset.push — explicit about local vs uploaded state. */
export interface PushResult {
  status: 'local_only' | 'uploaded';
  datasetId: string;
  datasetVersionId?: string | null;
  versionNumber?: number | null;
}

export interface DatasetSyncTransport {
  pushDataset(
    snapshot: DatasetSnapshot,
    baseVersionId: string | null,
    opts?: { onExisting?: OnExisting },
  ): Promise<PushResult>;
}

/** Default no-op: the dataset stays local; nothing is published. */
export class LocalDatasetSync implements DatasetSyncTransport {
  async pushDataset(
    snapshot: DatasetSnapshot,
    _baseVersionId?: string | null,
    _opts?: { onExisting?: OnExisting },
  ): Promise<PushResult> {
    return { status: 'local_only', datasetId: snapshot.datasetId };
  }
}

/** Deterministic in-memory sync for tests: versions, idempotency, conflicts. */
export class FakeDatasetSync implements DatasetSyncTransport {
  // Per-dataset version/idempotency/conflict state, so ONE instance can model several independent
  // server datasets. A single global cursor previously cross-contaminated them (a second dataset
  // would inherit the first's version and produce false conflicts or skip a real change).
  private readonly byDataset = new Map<
    string,
    { versionId: string | null; counter: number; revision: string | null }
  >();
  private lastDatasetId: string | null = null;
  readonly pushes: Array<[string, string, string]> = [];

  private stateFor(datasetId: string): {
    versionId: string | null;
    counter: number;
    revision: string | null;
  } {
    let s = this.byDataset.get(datasetId);
    if (!s) {
      s = { versionId: null, counter: 0, revision: null };
      this.byDataset.set(datasetId, s);
    }
    return s;
  }

  /** Current server version for a dataset (defaults to the most recently pushed one). */
  get currentVersionId(): string | null {
    return this.lastDatasetId ? (this.byDataset.get(this.lastDatasetId)?.versionId ?? null) : null;
  }

  /** Seed a server version to simulate the server moving ahead (test helper). Applies to the
   *  given dataset, or the most recently pushed one. */
  forceCurrentVersion(versionId: string, datasetId?: string): void {
    const id = datasetId ?? this.lastDatasetId;
    if (id === null)
      throw new Error('forceCurrentVersion: push a dataset first, or pass a datasetId');
    this.stateFor(id).versionId = versionId;
  }

  async pushDataset(
    snapshot: DatasetSnapshot,
    baseVersionId: string | null,
    opts?: { onExisting?: OnExisting },
  ): Promise<PushResult> {
    const s = this.stateFor(snapshot.datasetId);
    // In-memory sync has no remote existence to double-check; onExisting is consulted only when a
    // prior version already exists here (interface parity with PlatformDatasetSync).
    if (s.versionId !== null && opts?.onExisting) {
      const ok = await opts.onExisting({
        name: snapshot.name,
        current_dataset_version_id: s.versionId,
      });
      if (!ok)
        throw new DatasetPublishAborted(
          `publish to existing dataset '${snapshot.name}' declined; no new version created.`,
        );
    }
    this.lastDatasetId = snapshot.datasetId;
    if (s.versionId !== null && baseVersionId !== s.versionId) {
      throw new DatasetConflictError(baseVersionId, s.versionId);
    }
    if (snapshot.revision === s.revision) {
      return {
        status: 'uploaded',
        datasetId: snapshot.datasetId,
        datasetVersionId: s.versionId,
        versionNumber: s.counter,
      };
    }
    s.counter += 1;
    s.versionId = `dsv_${s.counter}`;
    s.revision = snapshot.revision;
    this.pushes.push([snapshot.datasetId, snapshot.revision, s.versionId]);
    return {
      status: 'uploaded',
      datasetId: snapshot.datasetId,
      datasetVersionId: s.versionId,
      versionNumber: s.counter,
    };
  }
}

/** Real dataset publish against the live backend (A2/A4). */
export class PlatformDatasetSync implements DatasetSyncTransport {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey?: string; baseUrl?: string } = {}) {
    const { apiKey, baseUrl } = TraceRoot.resolveCredentials(opts.apiKey, opts.baseUrl);
    if (!apiKey) throw new Error('PlatformDatasetSync needs an API key.');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private request(method: string, path: string, body?: unknown): Promise<any> {
    return httpJson(method, `${this.baseUrl}${path}`, this.apiKey, body);
  }

  /**
   * The remote dataset's metadata if it ALREADY exists with a published version, else null.
   *
   * ONLY a 404 means "no such dataset". Any other failure (401/403/5xx/timeout) says nothing
   * about whether the dataset exists, and reading it as "new" would skip BOTH the idempotent
   * no-op and the confirmation — publishing an unprompted version off a transient error. So
   * everything but a 404 propagates.
   */
  private async existingDataset(datasetId: string): Promise<ExistingDatasetInfo | null> {
    try {
      const meta = await this.request(
        'GET',
        `/api/v1/public/datasets/${encodeURIComponent(datasetId)}`,
      );
      return meta?.current_dataset_version_id ? meta : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(' HTTP 404:')) return null;
      throw err;
    }
  }

  /** The content revision of the dataset's current published version, for change detection. Null
   *  when it can't be fetched (then we fall through to confirm rather than assume unchanged). */
  private async publishedRevision(datasetId: string, versionId: string): Promise<string | null> {
    try {
      const current = await pullDatasetVersion(versionId, {
        datasetId,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
      });
      return current.snapshot().revision;
    } catch {
      return null;
    }
  }

  /**
   * Upsert the dataset's un-versioned metadata (key/name/description). Not a version.
   *
   * The `key` is what the datasetId was hashed from, and the platform cannot recover it from the
   * name (an explicit key, or a rename, hashes from something the name no longer spells). Sending
   * it lets a later pull return the REAL key instead of a guess, so a case added to a pulled
   * dataset gets the same id as one authored locally. The backend stores it on create and
   * backfills a null key; it never clobbers a key already set.
   */
  private async upsertDataset(snapshot: DatasetSnapshot): Promise<void> {
    const body: Record<string, unknown> = {
      dataset_id: snapshot.datasetId,
      name: snapshot.name,
      description: snapshot.description,
    };
    if (snapshot.key != null) body.key = snapshot.key;
    await this.request('POST', '/api/v1/public/datasets', body);
  }

  async pushDataset(
    snapshot: DatasetSnapshot,
    baseVersionId: string | null,
    opts?: { onExisting?: OnExisting },
  ): Promise<PushResult> {
    // A dataset's identity is its name: re-pushing the same name updates the SAME dataset with a
    // new version. If the content is UNCHANGED from the current version, this is a no-op (reuse it,
    // no prompt). If it CHANGED, double-check before creating a new version (default: prompt on an
    // interactive TTY, proceed otherwise) so a reused name never silently adds a version.
    const existing = await this.existingDataset(snapshot.datasetId);
    if (existing) {
      const currentVersion = existing.current_dataset_version_id as string;
      if (
        (await this.publishedRevision(snapshot.datasetId, currentVersion)) === snapshot.revision
      ) {
        // Identical content -> idempotent no-op; keep the current version, never prompt.
        // `name`/`description` are dataset metadata, NOT part of the content revision, so an edit
        // to either lands here with an unchanged revision. Returning without the upsert would make
        // `ds.description = ...; await ds.push()` a silent no-op, so send the metadata first and
        // only skip the VERSION.
        await this.upsertDataset(snapshot);
        return {
          status: 'uploaded',
          datasetId: snapshot.datasetId,
          datasetVersionId: currentVersion,
        };
      }
      const confirm = opts?.onExisting ?? confirmNewVersion;
      if (!(await confirm(existing)))
        // A declined publish leaves the remote entirely untouched — metadata included.
        throw new DatasetPublishAborted(
          `publish to existing dataset '${snapshot.name}' declined; no new version created.`,
        );
    }
    await this.upsertDataset(snapshot);
    // Native JSON at the HTTP boundary: input/expected/metadata are sent as their real
    // values; the backend owns the single JSON-encode. The SDK does NOT pre-encode.
    //
    // The value SENT is the SAME canonical form that was HASHED into the revision, so a pulled
    // version re-hashes to the revision that published it. Sending a differently-shaped value
    // (a Date here, an ISO string in storage; a Set here, `{}` in storage) would make
    // publishedRevision() != snapshot.revision forever, so every push — including evaluate()'s
    // auto-provision — would prompt and publish a no-change version, without bound.
    const changes: Record<string, unknown>[] = [];
    for (const c of snapshot.cases) {
      const change: Record<string, unknown> = {
        op: 'upsert',
        test_case_id: c.id,
        input: normalize(c.input),
      };
      if (c.expected !== undefined && c.expected !== null) change.expected = normalize(c.expected);
      if (c.metadata != null) change.metadata = normalize(c.metadata);
      if (c.sourceTraceId != null) change.source_trace_id = c.sourceTraceId;
      if (c.sourceSpanId != null) change.source_span_id = c.sourceSpanId;
      changes.push(change);
    }
    if (changes.length === 0)
      throw new Error('cannot publish a dataset version with no active cases');

    let resp: any;
    try {
      resp = await this.request(
        'POST',
        `/api/v1/public/datasets/${encodeURIComponent(snapshot.datasetId)}/versions`,
        {
          base_version_id: baseVersionId,
          changes,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(' HTTP 413:')) {
        throw new Error(
          `too many changes in one push (${changes.length}); the backend caps a version at ` +
            `~1000 changes. Split the dataset or publish in stages.`,
        );
      }
      if (msg.includes(' HTTP 409:')) {
        let current: string | null = null;
        try {
          current = JSON.parse(msg.split(' HTTP 409:')[1].trim()).current_version_id ?? null;
        } catch {
          /* ignore */
        }
        throw new DatasetConflictError(baseVersionId, current);
      }
      throw err;
    }
    return {
      status: 'uploaded',
      datasetId: snapshot.datasetId,
      datasetVersionId: resp.dataset_version_id ?? null,
      versionNumber: resp.version_number ?? null,
    };
  }
}
