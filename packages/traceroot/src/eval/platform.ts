// src/eval/platform.ts — platform reporting + dataset pull (parity with
// traceroot-py/traceroot/eval/platform.py). Same endpoints and wire payloads as the
// Python SDK, since the backend contract is shared.

import { TraceRoot } from '../traceroot';
import { Dataset } from './types';
import { resolveMainScorePolicy } from './results';
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

  const meta = await httpGetJson(
    `${baseUrl}/api/v1/public/datasets/${encodeURIComponent(datasetId)}`,
    apiKey,
  );
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
    snapshot = await httpGetJson(
      `${baseUrl}/api/v1/public/dataset-versions/${encodeURIComponent(versionId)}`,
      apiKey,
    );
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
  key?: string | null; // stable semantic identity (cross-language); defaults to `name`
  version?: string | null;
  scorer_type?: string | null;
  value_type?: string | null;
  direction?: string | null;
  threshold?: number | null;
  output_type?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  required_inputs?: string[] | null;
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

  // Per-case contribution keyed by test_case_id, so a retried case (or a repeated upload() with
  // the same transport) REPLACES its contribution instead of double-counting the completion totals.
  private readonly contrib = new Map<
    string,
    { status: string; main: number | null; scorerErrors: number }
  >();

  constructor(datasetId: string, opts: PlatformTransportOptions = {}) {
    const { apiKey, baseUrl } = TraceRoot.resolveCredentials(opts.apiKey, opts.baseUrl);
    if (!apiKey)
      throw new Error('PlatformTransport needs an API key (uploading requires credentials).');
    this.datasetId = datasetId;
    this.scorerNames = opts.scorerNames ?? [];
    this.scorerSpecs = opts.scorerSpecs;
    this.candidateVersion = opts.candidateVersion || 'sdk';
    this.environment = opts.environment ?? 'evaluation';
    // Registration reports mainScoreName ONLY when the user configured it. A single scorer's
    // metric is late-bound (resolved from what it actually emits) and reported at completion --
    // never fabricated from the scorer's function name here. Whether a run is name-agnostic is a
    // getter (see below), not cached here: an explicitly-built transport gets its scorerSpecs from
    // the engine AFTER construction, so a value frozen now would ignore them.
    this.mainScoreName = opts.mainScoreName ?? null;
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
        // Comparison metadata + the read-only definition. `key` is the stable semantic identity
        // (cross-language); language/source are provenance. Absent fields are omitted.
        for (const k of [
          'key',
          'scorer_type',
          'value_type',
          'direction',
          'threshold',
          'output_type',
          'description',
          'metadata',
          'required_inputs',
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

  /** A single scorer resolves its emitted metric name-agnostically (its one numeric/boolean score
   *  IS the main metric, even when the fn name differs from the emitted Score name). Derived from
   *  the CURRENT config on every access -- deliberately NOT cached in the constructor -- so it
   *  reflects the scorerSpecs the engine injects after construction. An explicit mainScoreName opts
   *  out (the configured metric owns it); zero or multiple scorers have no single headline metric. */
  private get nameAgnosticMain(): boolean {
    if (this.mainScoreName !== null) return false;
    const nScorers = this.scorerNames.length || (this.scorerSpecs?.length ?? 0);
    return nScorers === 1;
  }

  private effectiveThreshold(): number {
    // An explicit passThreshold wins; else the OWNING scorer's declared threshold (a single
    // scorer's declaration governs its emitted metric, even when its function name differs from
    // the emitted Score name). Uses the SAME policy resolver as the local result -- one rule.
    if (this.passThreshold !== null) return this.passThreshold;
    return resolveMainScorePolicy(this.scorerSpecs, this.mainScoreName)[0];
  }

  private effectiveDirection(): string {
    return resolveMainScorePolicy(this.scorerSpecs, this.mainScoreName)[1];
  }

  async createRun(
    name: string,
    _datasetName: string,
    metadata: Record<string, unknown> | null,
    clientRunId?: string,
    provenance?: Record<string, unknown> | null,
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
    // Typed execution provenance (git/CI/SDK identity) and free-form user metadata. Both
    // are optional on the backend; omit when empty to match its absent-or-null rules
    // rather than sending empty objects.
    if (provenance && Object.keys(provenance).length > 0) body.provenance = provenance;
    if (metadata && Object.keys(metadata).length > 0) body.metadata = metadata;
    const resp = await this.request('POST', '/api/v1/public/evaluation-runs', body);
    this.runId = resp.evaluation_run_id;
    // Optional, absent on older/self-hosted backends. Prefer the absolute run_url (resolved
    // against the UI origin) so the link is correct across split API/UI origins; keep
    // run_path as a same-origin fallback.
    this.runUrl = resp.run_url ?? null;
    this.runPath = resp.run_path ?? null;
    return { name, datasetName: _datasetName, metadata };
  }

  async registerItem(): Promise<void> {
    // The item->trace link is folded into the result upsert (contract), so no-op.
  }

  async recordItemResult(_run: RunHandle, item: EvalItemResult): Promise<void> {
    const [status, main] = this.statusAndMain(item);
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
    // Record this case's contribution only AFTER the upsert persisted, keyed by id so a retry or
    // repeated upload replaces (not adds to) the completion aggregate.
    this.contrib.set(item.caseId, {
      status,
      main,
      scorerErrors: Object.keys(item.scorerErrors).length,
    });
  }

  async recordScores(): Promise<void> {
    // Already sent inside recordItemResult (which carries the full item).
  }

  /** The registration scorer refs augmented with the metrics each DEFINITION actually emitted during
   *  the run. The platform keys a metric's policy on the EMITTED-metric name, so a definition whose
   *  function name differs from its emitted metric (`grade` -> `quality`) must declare that ownership
   *  here or the platform can't resolve the metric's threshold/direction. Each emitted metric carries
   *  the definition's declared policy (a scorer's declaration governs whatever metric it emits).
   *  Rebuilt from the SAME refs registration sent, so completion merges by definition name. */
  private resolvedScorerManifest(emitted: Record<string, string[]>): Record<string, unknown>[] {
    return this.scorerRefs().map((ref) => {
      const metrics = emitted[ref.name as string];
      if (!metrics || metrics.length === 0) return ref;
      const policy: Record<string, unknown> = {};
      for (const k of ['value_type', 'direction', 'threshold'] as const) {
        if (ref[k] != null) policy[k] = ref[k];
      }
      return { ...ref, emitted_metrics: metrics.map((name) => ({ name, ...policy })) };
    });
  }

  async finishRun(
    _run: RunHandle,
    statusOverride?: string | null,
    mainScoreName?: string | null,
    emittedMetrics?: Record<string, string[]> | null,
  ): Promise<UploadState> {
    // Pure reporter: the engine owns the ONE main-score resolution and passes the terminal
    // status (e.g. 'failed' on a misconfiguration) and the resolved mainScoreName.
    // Derive the completion aggregate from the per-case map, so counts always match the distinct
    // cases actually persisted (no inflation from retries/replays).
    let scored = 0;
    let taskErrors = 0;
    let scorerErrors = 0;
    let mainSum = 0;
    let mainCount = 0;
    for (const c of this.contrib.values()) {
      if (c.status === 'errored') taskErrors += 1;
      else if (c.status === 'passed' || c.status === 'failed') scored += 1;
      if (c.main !== null) {
        mainSum += c.main;
        mainCount += 1;
      }
      scorerErrors += c.scorerErrors;
    }
    const status =
      statusOverride ?? (taskErrors || scorerErrors ? 'completed_with_errors' : 'completed');
    const body: Record<string, unknown> = {
      status,
      scored_count: scored,
      task_error_count: taskErrors,
      scorer_error_count: scorerErrors,
    };
    if (mainCount) body.main_score = mainSum / mainCount;
    // Send the resolved headline metric NAME so a late-bound single-metric run records its true
    // identity at completion (not just at registration, where it may be unknown). Coordinated with
    // the backend adding optional main_score_name to CompleteRunRequest.
    if (mainScoreName != null) body.main_score_name = mainScoreName;
    // The RESOLVED scorer->emitted-metric manifest, discovered during execution. The platform merges
    // it (by definition name) into the stored manifest so each emitted metric's policy is keyed on
    // the metric name for reconciliation, read-back, and comparison. Additive.
    if (emittedMetrics && Object.keys(emittedMetrics).length > 0) {
      const manifest = this.resolvedScorerManifest(emittedMetrics);
      if (manifest.length > 0) body.scorers = manifest;
    }
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
        scorer_version: s.version || UNVERSIONED_SCORER,
      };
      if (typeof s.value === 'boolean') entry.bool_value = s.value;
      else if (typeof s.value === 'number') entry.numeric_value = s.value;
      else entry.string_value = String(s.value);
      if (s.comment !== undefined && s.comment !== null) entry.explanation = s.comment;
      const passed = this.scorePassed(s);
      if (passed !== null) entry.passed = passed;
      payload.push(entry);
    }
    for (const [name, msg] of Object.entries(item.scorerErrors)) {
      payload.push({ scorer_name: name, scorer_version: UNVERSIONED_SCORER, error: msg });
    }
    return payload;
  }

  private static numericScore(value: unknown): number | null {
    if (typeof value === 'boolean') return value ? 1.0 : 0.0;
    if (typeof value === 'number') return value;
    return null;
  }

  /** (threshold, direction) for ONE emitted metric, or null when it can't be resolved without
   *  guessing. A single scorer's declared policy owns whatever metric it emits, even when the
   *  function name differs from the emitted Score name (name-agnostic). With multiple scorers the
   *  emitted name must match a declared scorer; an unmatched metric returns null so the platform is
   *  told 'unknown', never a fabricated pass/fail. Mirrors resolveMainScorePolicy per-score. */
  private scorePolicy(name: string | null): [number, string] | null {
    const specs = this.scorerSpecs ?? [];
    const owner = specs.length === 1 ? specs[0] : (specs.find((s) => s.name === name) ?? null);
    if (!owner) return null;
    return [
      owner.threshold != null ? owner.threshold : DEFAULT_PASS_THRESHOLD,
      owner.direction != null ? owner.direction : 'higher_is_better',
    ];
  }

  /** SDK-computed pass/fail for one emitted metric, derived at serialization time and never stored
   *  on the Score. Boolean: true = pass. Numeric: compared against the OWNING scorer's
   *  threshold+direction (the same policy that decides the case status, so a single scorer's main
   *  score and its per-score `passed` always agree). Categorical, a 'none'-direction metric, or a
   *  numeric metric whose policy can't be resolved have no pass/fail -> null (never guessed). */
  private scorePassed(score: EvalItemResult['scores'][number]): boolean | null {
    if (typeof score.value === 'boolean') return score.value;
    if (typeof score.value !== 'number') return null;
    const policy = this.scorePolicy(score.name);
    if (policy === null) return null;
    const [threshold, direction] = policy;
    if (direction === 'lower_is_better') return score.value <= threshold;
    if (direction === 'none') return null;
    return score.value >= threshold; // higher_is_better (the default)
  }

  /** The run's main-metric value for one case, or null when unresolved. Name-agnostic for a
   *  single unconfigured scorer; matched by name when an explicit main is set; null when
   *  multiple scorers have no configured main (genuinely no headline metric). */
  private mainValue(scores: EvalItemResult['scores']): number | null {
    if (this.nameAgnosticMain) {
      for (const s of scores) {
        const v = PlatformTransport.numericScore(s.value);
        if (v !== null) return v;
      }
      return null;
    }
    if (this.mainScoreName === null) return null;
    for (const s of scores) {
      if (s.name === this.mainScoreName) return PlatformTransport.numericScore(s.value);
    }
    return null;
  }

  private statusAndMain(item: EvalItemResult): [string, number | null] {
    if (item.error !== null) return ['errored', null];
    const main = this.mainValue(item.scores);
    if (main === null) return ['not_scored', null];
    const threshold = this.effectiveThreshold();
    const direction = this.effectiveDirection();
    let passed: boolean;
    if (direction === 'lower_is_better') passed = main <= threshold;
    else if (direction === 'none') return ['not_scored', main];
    else passed = main >= threshold; // higher_is_better (the default)
    return [passed ? 'passed' : 'failed', main];
  }
}
