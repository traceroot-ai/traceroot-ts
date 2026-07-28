// src/eval/platform.ts — platform reporting + dataset pull (parity with
// traceroot-py/traceroot/eval/platform.py). Same endpoints and wire payloads as the
// Python SDK, since the backend contract is shared.

import { TraceRoot } from '../traceroot';
import { Dataset } from './types';
import type { EvalItemResult, UploadState } from './results';
import type { EvalTransport, RunHandle, PublishResult } from './transport';

const UNVERSIONED_SCORER = 'unversioned';
const DEFAULT_PASS_THRESHOLD = 1.0;

// --- HTTP seam (fetch) -------------------------------------------------------
async function httpGetJson(url: string, apiKey: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function httpJson(
  method: string,
  url: string,
  apiKey: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${method} ${url} -> HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

/** Result-reporting fields are backend z.string(); a non-string is JSON-encoded. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Per-case duration for the wire: a nonnegative INTEGER of ms, or null when unknown. */
function durationMs(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.round(value));
}

export interface PullOptions {
  versionId?: string;
  apiKey?: string;
  baseUrl?: string;
}

function datasetFromVersion(snapshot: any, name: string): Dataset {
  // Native JSON at the HTTP boundary: the backend already JSON-decodes input/expected
  // before returning them, so the SDK takes the values as-is (no re-decode).
  const ds = new Dataset(name);
  ds.datasetId = snapshot.dataset_id ?? undefined;
  ds.datasetVersionId = snapshot.dataset_version_id ?? undefined;
  for (const item of snapshot.items ?? []) {
    ds.upsert({
      id: item.test_case_id,
      input: item.input,
      expected: item.expected,
      metadata: item.metadata ?? null,
      sourceTraceId: item.source_trace_id ?? undefined,
      sourceSpanId: item.source_span_id ?? undefined,
    });
  }
  return ds;
}

/**
 * Fetch a platform dataset into a local Dataset.
 *
 * Pull data, not runs: reproduce a run by pulling its `datasetVersionId` (see
 * {@link pullDatasetVersion}) — there is no pullRun. Without `versionId` the CURRENT
 * published version is pulled; with it, that EXACT immutable version (validated to
 * belong to `datasetId`). The returned Dataset carries `datasetId`/`datasetVersionId`.
 */
export async function pullDataset(datasetId: string, opts: PullOptions = {}): Promise<Dataset> {
  const { apiKey, baseUrl } = TraceRoot.resolveCredentials(opts.apiKey, opts.baseUrl);
  if (!apiKey)
    throw new Error('pullDataset needs an API key (initialize TraceRoot or pass apiKey).');

  const meta = await httpGetJson(`${baseUrl}/api/v1/public/datasets/${datasetId}`, apiKey);
  const versionId = opts.versionId ?? meta.current_dataset_version_id;
  return pullDatasetVersion(versionId, {
    datasetId,
    name: meta.name ?? datasetId,
    apiKey,
    baseUrl,
  });
}

export interface PullVersionOptions {
  datasetId?: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Fetch one EXACT immutable dataset version by id — this is how you reproduce a run:
 * pass the run's `datasetVersionId` to get the exact cases it scored, then bring your own
 * task + scorers (only the data lives on the platform; there is no pullRun). When
 * `datasetId` is supplied the version is validated to belong to it.
 */
export async function pullDatasetVersion(
  versionId: string,
  opts: PullVersionOptions = {},
): Promise<Dataset> {
  const { apiKey, baseUrl } = TraceRoot.resolveCredentials(opts.apiKey, opts.baseUrl);
  if (!apiKey)
    throw new Error('pullDatasetVersion needs an API key (initialize TraceRoot or pass apiKey).');

  let snapshot: any;
  try {
    snapshot = await httpGetJson(`${baseUrl}/api/v1/public/dataset-versions/${versionId}`, apiKey);
  } catch (err) {
    if (err instanceof Error && / HTTP 404:/.test(err.message)) {
      throw new Error(`dataset version ${JSON.stringify(versionId)} not found`);
    }
    throw err;
  }

  const returnedDatasetId = snapshot.dataset_id ?? null;
  if (opts.datasetId && returnedDatasetId && returnedDatasetId !== opts.datasetId) {
    throw new Error(
      `dataset version ${JSON.stringify(versionId)} belongs to dataset ` +
        `${JSON.stringify(returnedDatasetId)}, not ${JSON.stringify(opts.datasetId)}`,
    );
  }
  const ds = datasetFromVersion(
    snapshot,
    opts.name ?? returnedDatasetId ?? opts.datasetId ?? versionId,
  );
  ds.datasetVersionId = ds.datasetVersionId ?? versionId;
  ds.datasetId = ds.datasetId ?? opts.datasetId ?? undefined;
  return ds;
}

export interface ScorerSpec {
  name: string;
  version?: string | null;
  scorer_type?: string | null;
  value_type?: string | null;
  direction?: string | null;
  threshold?: number | null;
  output_type?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  language?: string | null;
  source?: string | null;
  model?: string | null;
  messages?: unknown;
}

export interface PlatformTransportOptions {
  scorerNames?: string[];
  scorerSpecs?: ScorerSpec[];
  candidateVersion?: string | null;
  environment?: string;
  mainScoreName?: string | null;
  datasetVersionId?: string | null;
  clientRunId?: string | null;
  passThreshold?: number | null;
  apiKey?: string;
  baseUrl?: string;
}

/** Reports an evaluation run to the TraceRoot backend. One instance per run. */
export class PlatformTransport implements EvalTransport {
  readonly reportsTraces = true;
  runId: string | null = null;
  /** Absolute UI run link from the backend (resolved against the UI origin), when present. */
  runUrl: string | null = null;
  /** UI-relative run path from the backend — same-origin fallback for runUrl. */
  runPath: string | null = null;

  private readonly datasetId: string;
  private readonly scorerNames: string[];
  /** Rich scorer descriptors (value_type/direction/threshold); the engine fills this when
   *  the caller leaves it undefined. Falls back to scorerNames when unset. */
  scorerSpecs?: ScorerSpec[];
  private readonly candidateVersion: string;
  private readonly environment: string;
  private readonly mainScoreName: string | null;
  private readonly datasetVersionId: string | null;
  private readonly clientRunId: string | null;
  private readonly passThreshold: number | null;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  private scored = 0;
  private taskErrors = 0;
  private scorerErrors = 0;
  private mainSum = 0;
  private mainCount = 0;

  constructor(datasetId: string, opts: PlatformTransportOptions = {}) {
    const { apiKey, baseUrl } = TraceRoot.resolveCredentials(opts.apiKey, opts.baseUrl);
    if (!apiKey)
      throw new Error('PlatformTransport needs an API key (uploading requires credentials).');
    this.datasetId = datasetId;
    this.scorerNames = opts.scorerNames ?? [];
    this.scorerSpecs = opts.scorerSpecs;
    this.candidateVersion = opts.candidateVersion || 'sdk';
    this.environment = opts.environment ?? 'evaluation';
    this.mainScoreName = opts.mainScoreName ?? this.scorerNames[0] ?? null;
    this.datasetVersionId = opts.datasetVersionId ?? null;
    this.clientRunId = opts.clientRunId ?? null;
    this.passThreshold = opts.passThreshold ?? null;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private request(method: string, path: string, body?: unknown): Promise<any> {
    return httpJson(method, `${this.baseUrl}${path}`, this.apiKey, body);
  }

  private scorerRefs(): Record<string, unknown>[] {
    if (this.scorerSpecs && this.scorerSpecs.length > 0) {
      return this.scorerSpecs.map((spec) => {
        const ref: Record<string, unknown> = {
          name: spec.name,
          version: spec.version || UNVERSIONED_SCORER,
        };
        // Comparison metadata + the read-only definition. Absent fields are omitted.
        for (const k of [
          'scorer_type',
          'value_type',
          'direction',
          'threshold',
          'output_type',
          'description',
          'metadata',
          'language',
          'source',
          'model',
          'messages',
        ] as const) {
          if (spec[k] != null) ref[k] = spec[k];
        }
        return ref;
      });
    }
    return this.scorerNames.map((n) => ({ name: n, version: UNVERSIONED_SCORER }));
  }

  private effectiveThreshold(): number {
    if (this.passThreshold !== null) return this.passThreshold;
    for (const spec of this.scorerSpecs ?? []) {
      if (spec.name === this.mainScoreName && spec.threshold != null) return spec.threshold;
    }
    return DEFAULT_PASS_THRESHOLD;
  }

  async createRun(
    name: string,
    _datasetName: string,
    _metadata: Record<string, unknown> | null,
    clientRunId?: string,
  ): Promise<RunHandle> {
    const body: Record<string, unknown> = {
      evaluation_name: name,
      dataset_id: this.datasetId,
      candidate_version: this.candidateVersion,
      environment: this.environment,
      scorers: this.scorerRefs(),
    };
    if (this.datasetVersionId !== null) body.dataset_version_id = this.datasetVersionId;
    if (this.mainScoreName !== null) body.main_score_name = this.mainScoreName;
    const effectiveClientRun = clientRunId ?? this.clientRunId;
    if (effectiveClientRun != null) body.client_run_id = effectiveClientRun;
    const resp = await this.request('POST', '/api/v1/public/evaluation-runs', body);
    this.runId = resp.evaluation_run_id;
    // Optional, absent on older/self-hosted backends. Prefer the absolute run_url (resolved
    // against the UI origin) so the link is correct across split API/UI origins; keep
    // run_path as a same-origin fallback.
    this.runUrl = resp.run_url ?? null;
    this.runPath = resp.run_path ?? null;
    return { name, datasetName: _datasetName, metadata: _metadata };
  }

  async registerItem(): Promise<void> {
    // The item->trace link is folded into the result upsert (contract), so no-op.
  }

  async recordItemResult(_run: RunHandle, item: EvalItemResult): Promise<void> {
    const [status, main] = this.statusAndMain(item);
    if (status === 'errored') this.taskErrors += 1;
    else if (status === 'passed' || status === 'failed') this.scored += 1;
    if (main !== null) {
      this.mainSum += main;
      this.mainCount += 1;
    }
    this.scorerErrors += Object.keys(item.scorerErrors).length;
    await this.request('POST', `/api/v1/public/evaluation-runs/${this.runId}/results`, {
      test_case_id: item.caseId,
      trace_id: item.traceId,
      input: asText(item.input) ?? '',
      expected_output: asText(item.expected),
      candidate_output: asText(item.output),
      status,
      main_score: main,
      task_error: item.error,
      duration_ms: durationMs(item.durationMs),
      scores: this.scoresPayload(item),
    });
  }

  async recordScores(): Promise<void> {
    // Already sent inside recordItemResult (which carries the full item).
  }

  async finishRun(_run: RunHandle, statusOverride?: string | null): Promise<UploadState> {
    const status =
      statusOverride ??
      (this.taskErrors || this.scorerErrors ? 'completed_with_errors' : 'completed');
    const body: Record<string, unknown> = {
      status,
      scored_count: this.scored,
      task_error_count: this.taskErrors,
      scorer_error_count: this.scorerErrors,
    };
    if (this.mainCount) body.main_score = this.mainSum / this.mainCount;
    await this.request('POST', `/api/v1/public/evaluation-runs/${this.runId}/complete`, body);
    // Join the backend's UI-relative run path with our host; null when absent.
    // Prefer the backend's absolute run_url; fall back to baseUrl + run_path for a control
    // plane that predates run_url (keeps the same-origin behavior).
    const url = this.runUrl ?? (this.runPath ? `${this.baseUrl}${this.runPath}` : null);
    return { status: 'uploaded', dashboardUrl: url };
  }

  async publishDataset(datasetName: string, itemCount: number): Promise<PublishResult> {
    // Datasets are server/UI-owned; the SDK cannot create them. Stay local-only.
    return { status: 'local_only', datasetName, itemCount };
  }

  private scoresPayload(item: EvalItemResult): Record<string, unknown>[] {
    const payload: Record<string, unknown>[] = [];
    for (const s of item.scores) {
      const entry: Record<string, unknown> = {
        scorer_name: s.name,
        scorer_version: UNVERSIONED_SCORER,
      };
      if (typeof s.value === 'boolean') entry.bool_value = s.value;
      else if (typeof s.value === 'number') entry.numeric_value = s.value;
      else entry.string_value = String(s.value);
      if (s.comment !== undefined && s.comment !== null) entry.explanation = s.comment;
      payload.push(entry);
    }
    for (const [name, msg] of Object.entries(item.scorerErrors)) {
      payload.push({ scorer_name: name, scorer_version: UNVERSIONED_SCORER, error: msg });
    }
    return payload;
  }

  private statusAndMain(item: EvalItemResult): [string, number | null] {
    if (item.error !== null) return ['errored', null];
    let main: number | null = null;
    for (const s of item.scores) {
      if (this.mainScoreName !== null && s.name !== this.mainScoreName) continue;
      if (typeof s.value === 'boolean') {
        main = s.value ? 1.0 : 0.0;
        break;
      }
      if (typeof s.value === 'number') {
        main = s.value;
        break;
      }
      if (this.mainScoreName !== null) break; // named main is categorical -> no numeric main
    }
    if (main === null) return ['not_scored', null];
    return [main >= this.effectiveThreshold() ? 'passed' : 'failed', main];
  }
}
