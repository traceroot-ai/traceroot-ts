// src/eval/dataset_sync.ts — explicit dataset publication seam (parity with
// traceroot-py/traceroot/eval/dataset_sync.py).
//
// One explicit Dataset.push() = one immutable server dataset version, with
// optimistic-concurrency conflict detection (baseVersionId). Local mutations never create
// versions. Default LocalDatasetSync is local-only; FakeDatasetSync drives tests;
// PlatformDatasetSync publishes to POST /api/v1/public/datasets + .../{id}/versions.

import { TraceRoot } from '../traceroot';
import { httpJson } from './platform';
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

/** Outcome of Dataset.push — explicit about local vs uploaded state. */
export interface PushResult {
  status: 'local_only' | 'uploaded';
  datasetId: string;
  datasetVersionId?: string | null;
  versionNumber?: number | null;
}

export interface DatasetSyncTransport {
  pushDataset(snapshot: DatasetSnapshot, baseVersionId: string | null): Promise<PushResult>;
}

/** Default no-op: the dataset stays local; nothing is published. */
export class LocalDatasetSync implements DatasetSyncTransport {
  async pushDataset(snapshot: DatasetSnapshot): Promise<PushResult> {
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

  private stateFor(datasetId: string): { versionId: string | null; counter: number; revision: string | null } {
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
    if (id === null) throw new Error('forceCurrentVersion: push a dataset first, or pass a datasetId');
    this.stateFor(id).versionId = versionId;
  }

  async pushDataset(snapshot: DatasetSnapshot, baseVersionId: string | null): Promise<PushResult> {
    const s = this.stateFor(snapshot.datasetId);
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

  async pushDataset(snapshot: DatasetSnapshot, baseVersionId: string | null): Promise<PushResult> {
    await this.request('POST', '/api/v1/public/datasets', {
      dataset_id: snapshot.datasetId,
      name: snapshot.name,
      description: snapshot.description,
    });
    // Native JSON at the HTTP boundary: input/expected/metadata are sent as their real
    // values; the backend owns the single JSON-encode. The SDK does NOT pre-encode.
    const changes: Record<string, unknown>[] = [];
    for (const c of snapshot.cases) {
      const change: Record<string, unknown> = { op: 'upsert', test_case_id: c.id, input: c.input };
      if (c.expected !== undefined && c.expected !== null) change.expected = c.expected;
      if (c.metadata != null) change.metadata = c.metadata;
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
