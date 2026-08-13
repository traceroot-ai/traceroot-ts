// src/eval/platform.ts — platform reporting + dataset pull (parity with
// traceroot-py/traceroot/eval/platform.py). Same endpoints and wire payloads as the
// Python SDK, since the backend contract is shared.

import { TraceRoot } from '../traceroot';
import { Dataset } from './types';
import { stableDatasetId } from './ids';
import { caseStatus } from './results';
import type { EvalItemResult, UploadState } from './results';
import type { EvalTransport, RunHandle, PublishResult } from './transport';

const UNVERSIONED_SCORER = 'unversioned';

/** Every HTTP call is bounded so a hung backend can't hang the whole eval (parity with the
 *  Python SDK's 30s urlopen timeout). Overridable per call for tests. */
export const HTTP_TIMEOUT_MS = 30_000;

// --- Contract caps (frontend/packages/core/src/eval-contract.ts) -------------
// The backend REJECTS an over-cap field, and a 400 on one result aborts the whole run. The
// SDK clamps at this serialization boundary instead, with an explicit marker so a consumer
// never mistakes a cap for real data. Keep these values (and the marker) identical to the
// Python SDK's traceroot/eval/platform.py.
export const TRUNCATION_SUFFIX = '...[truncated]';
export const STRING_VALUE_MAX = 2_000;
export const EXPLANATION_MAX = 5_000;
export const SCORE_ERROR_MAX = 5_000;
export const TASK_ERROR_MAX = 10_000;
export const PAYLOAD_TEXT_MAX = 1_000_000;
export const SCORER_SOURCE_MAX = 50_000;
export const METADATA_MAX = 64_000;

/** Bound one string field to `limit` characters, marking any truncation. The result is
 *  exactly `limit` characters long when it had to be cut. */
function clamp(text: string | null, limit: number): string | null {
  if (text === null || text.length <= limit) return text;
  return text.slice(0, limit - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/** Bound a free-form metadata object by its SERIALIZED size (the contract's rule). Over-cap
 *  metadata collapses to an explicit truncation marker rather than 400ing. */
function clampMetadata(value: unknown, limit: number): unknown {
  if (value === null || value === undefined) return value;
  let text: string;
  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    return value;
  }
  if (text.length <= limit) return value;
  return { truncated: true, preview: clamp(text, limit - 32) };
}

// --- HTTP seam (fetch) -------------------------------------------------------
/** `res.json()` throws on an empty body; the backend answers some POSTs with no content. */
async function parseJson(res: Response): Promise<any> {
  const raw = await res.text();
  return raw ? JSON.parse(raw) : {};
}

async function httpGetJson(url: string, apiKey: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${detail}`);
  }
  return parseJson(res);
}

export async function httpJson(
  method: string,
  url: string,
  apiKey: string,
  body?: unknown,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${method} ${url} -> HTTP ${res.status}: ${detail}`);
  }
  return parseJson(res);
}

/** Result-reporting fields are backend z.string(); a non-string is JSON-encoded. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** True for a NaN/Infinity score value (booleans and strings never are). */
function isNonFinite(value: unknown): value is number {
  return typeof value === 'number' && !Number.isFinite(value);
}

/** ONE language-neutral spelling for a non-finite value. Python renders these `nan`/`inf` and
 *  JavaScript `NaN`/`Infinity`; the wire uses the JSON-familiar spelling in both SDKs so the same
 *  scorer bug reads identically whichever one produced it. */
function nonFiniteToken(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  return value > 0 ? 'Infinity' : '-Infinity';
}

/** The scorer error a non-finite score is reported as. Byte-identical to the Python SDK. */
function nonFiniteError(name: string, value: number): string {
  return (
    `ValueError: scorer '${name}' returned a non-finite score value ` +
    `(${nonFiniteToken(value)}); a numeric score must be finite`
  );
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

/**
 * The dataset's authoring key, when it can be PROVEN from what the platform returned.
 *
 * Only used for datasets that predate the `key` contract (or were authored in the UI), whose
 * responses carry no key: it is then recoverable exactly when the display name still hashes to
 * the dataset id (the default `key === name` case). A dataset published under an explicit key, or
 * renamed since, is not recoverable this way — and guessing would hand every subsequently added
 * case a divergent id, so the caller falls back to the dataset id (unambiguous and stable)
 * instead of a plausible lie.
 */
function recoveredKey(name: string, datasetId: string | undefined): string | undefined {
  return datasetId && stableDatasetId(name) === datasetId ? name : undefined;
}

/**
 * Build a local Dataset pinned to the exact version described by `snapshot`.
 *
 * `key` is the key the platform echoed for the dataset. It is the authoritative one — taken
 * verbatim, never re-derived — so a case added to the pulled dataset gets the same id as one
 * authored locally, even under a display name that is not the key. Only when the platform echoes
 * no key does the name-hash heuristic run.
 */
function datasetFromVersion(snapshot: any, name: string, key?: string | null): Dataset {
  // Native JSON at the HTTP boundary: the backend already JSON-decodes input/expected
  // before returning them, so the SDK takes the values as-is (no re-decode).
  const datasetId = snapshot.dataset_id ?? undefined;
  // `||`, not `??`: an empty key is no key, and Python resolves this same chain by truthiness.
  const resolvedKey = key || snapshot.key || recoveredKey(name, datasetId) || datasetId;
  const ds = new Dataset(name, null, { key: resolvedKey });
  ds.datasetId = datasetId;
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
    // The dataset response echoes the authoring key (null for datasets that predate the contract
    // or were authored in the UI); the version endpoint does not carry it.
    key: meta.key ?? null,
    apiKey,
    baseUrl,
  });
}

export interface PullVersionOptions {
  datasetId?: string;
  name?: string;
  /**
   * The dataset's authoring key as echoed by the platform (`pullDataset` passes it through); pass
   * it when pulling a bare version id whose dataset key you already know, so cases added to the
   * result get ids that converge with local authoring.
   */
  key?: string | null;
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
    opts.key,
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
  datasetVersionId?: string | null;
  clientRunId?: string | null;
  passThreshold?: number | null;
  apiKey?: string;
  baseUrl?: string;
}

/** Warn once per metric name emitted by more than one scorer DEFINITION.
 *
 *  The engine already rejects two scorers resolving to the same name before the run. What survives
 *  to here is the dynamic case: a metric-map scorer whose emitted names are only known once it has
 *  run. The platform keys a metric's direction/threshold on the metric name, so a name owned by two
 *  definitions has ambiguous policy and is compared non-directionally. Never throws — the run has
 *  already succeeded and the platform degrades gracefully; failing the completion would be worse. */
function warnOnMetricNameCollisions(contributors: Map<string, string[]>): void {
  for (const metric of [...contributors.keys()].sort()) {
    const owners = contributors.get(metric)!;
    if (owners.length < 2) continue;
    const listed = [...owners]
      .sort()
      .map((o) => `'${o}'`)
      .join(', ');
    console.warn(
      `scorers ${listed} all emit the metric name '${metric}'; the platform keys a metric's ` +
        `direction and threshold on its name, so '${metric}' will be compared ` +
        'non-directionally. Give each scorer a distinct metric name (or key).',
    );
  }
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
  private readonly datasetVersionId: string | null;
  private readonly clientRunId: string | null;
  private readonly passThreshold: number | null;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  // Per-case contribution keyed by test_case_id, so a retried case (or a repeated upload() with
  // the same transport) REPLACES its contribution instead of double-counting the completion totals.
  private readonly contrib = new Map<
    string,
    { taskError: boolean; scorerErrors: number; scored: boolean }
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
        // Contract-capped fields on the definition: a long captured source or a fat metadata
        // blob must not 400 the whole registration.
        if (ref.source != null) ref.source = clamp(String(ref.source), SCORER_SOURCE_MAX);
        if (ref.metadata != null) ref.metadata = clampMetadata(ref.metadata, METADATA_MAX);
        return ref;
      });
    }
    return this.scorerNames.map((n) => ({ name: n, version: UNVERSIONED_SCORER }));
  }

  async createRun(
    name: string,
    _datasetName: string,
    metadata: Record<string, unknown> | null,
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
    const effectiveClientRun = clientRunId ?? this.clientRunId;
    if (effectiveClientRun != null) body.client_run_id = effectiveClientRun;
    // Free-form user metadata only; optional on the backend, so omit when empty to match
    // its absent-or-null rules rather than sending an empty object.
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
    // Per-case status is errored (task error OR scorer error) | not_scored — no headline pass/fail.
    // Per-metric verdicts ride each score's `passed` (see scoresPayload/scorePassed).
    // A NaN/Infinity score is a scorer failure discovered at serialization time (see
    // scoresPayload), so it errors the case exactly like a thrown scorer would.
    const nonFinite = item.scores.filter((s) => isNonFinite(s.value)).length;
    const status = nonFinite > 0 ? 'errored' : caseStatus(item);
    await this.request('POST', `/api/v1/public/evaluation-runs/${this.runId}/results`, {
      test_case_id: item.caseId,
      trace_id: item.traceId,
      input: clamp(asText(item.input), PAYLOAD_TEXT_MAX) ?? '',
      expected_output: clamp(asText(item.expected), PAYLOAD_TEXT_MAX),
      candidate_output: clamp(asText(item.output), PAYLOAD_TEXT_MAX),
      status,
      task_error: clamp(item.error, TASK_ERROR_MAX),
      duration_ms: durationMs(item.durationMs),
      scores: this.scoresPayload(item),
    });
    // Record this case's contribution only AFTER the upsert persisted, keyed by id so a retry or
    // repeated upload replaces (not adds to) the completion aggregate.
    this.contrib.set(item.caseId, {
      taskError: item.error !== null,
      scorerErrors: Object.keys(item.scorerErrors).length + nonFinite,
      // A case that produced at least one score (and no task error) counts toward scored_count;
      // it is a COMPLETENESS count, not a pass/fail rollup (every score carries its own `passed`).
      scored: item.error === null && item.scores.length > nonFinite,
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
    // metric name -> the definitions that contributed it, for the uniqueness check below.
    const contributors = new Map<string, string[]>();
    const manifest = this.scorerRefs().map((ref) => {
      const metrics = emitted[ref.name as string];
      if (!metrics || metrics.length === 0) return ref;
      const policy: Record<string, unknown> = {};
      for (const k of ['value_type', 'direction', 'threshold'] as const) {
        if (ref[k] != null) policy[k] = ref[k];
      }
      for (const m of metrics)
        contributors.set(m, [...(contributors.get(m) ?? []), String(ref.name)]);
      return { ...ref, emitted_metrics: metrics.map((name) => ({ name, ...policy })) };
    });
    warnOnMetricNameCollisions(contributors);
    return manifest;
  }

  async finishRun(
    _run: RunHandle,
    statusOverride?: string | null,
    emittedMetrics?: Record<string, string[]> | null,
  ): Promise<UploadState> {
    // Pure reporter: the engine passes the terminal status (e.g. 'incomplete' on cancellation).
    // Derive the completion aggregate from the per-case map, so counts always match the distinct
    // cases actually persisted (no inflation from retries/replays). scored_count rides the same
    // map: it reports how many cases produced a score, not how many "passed".
    let taskErrors = 0;
    let scorerErrors = 0;
    let scored = 0;
    for (const c of this.contrib.values()) {
      if (c.taskError) taskErrors += 1;
      scorerErrors += c.scorerErrors;
      if (c.scored) scored += 1;
    }
    const status =
      statusOverride ?? (taskErrors || scorerErrors ? 'completed_with_errors' : 'completed');
    const body: Record<string, unknown> = {
      status,
      scored_count: scored,
      task_error_count: taskErrors,
      scorer_error_count: scorerErrors,
    };
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
      if (isNonFinite(s.value)) {
        // NaN/Infinity is not a JSON number. Emitted raw, JavaScript writes null (a silently
        // fabricated empty score that poisons the aggregate mean) while Python writes a bare NaN
        // token the backend's JSON.parse rejects (400ing the whole run). Both SDKs report it as
        // what it is: the scorer failed to produce a value.
        entry.error = clamp(nonFiniteError(s.name, s.value), SCORE_ERROR_MAX);
        payload.push(entry);
        continue;
      }
      if (typeof s.value === 'boolean') entry.bool_value = s.value;
      else if (typeof s.value === 'number') entry.numeric_value = s.value;
      else entry.string_value = clamp(String(s.value), STRING_VALUE_MAX);
      if (s.comment !== undefined && s.comment !== null)
        entry.explanation = clamp(s.comment, EXPLANATION_MAX);
      const passed = this.scorePassed(s, item.scores.length === 1);
      if (passed !== null) entry.passed = passed;
      payload.push(entry);
    }
    // A failing scorer is a score with an error and no value. Use the scorer's DECLARED version
    // (from the manifest) so an errored versioned scorer isn't misattributed to 'unversioned'.
    for (const [name, msg] of Object.entries(item.scorerErrors)) {
      payload.push({
        scorer_name: name,
        scorer_version: this.declaredVersion(name),
        error: clamp(msg, SCORE_ERROR_MAX),
      });
    }
    return payload;
  }

  /** Declared manifest version for a scorer name, or the sentinel when none was declared. */
  private declaredVersion(name: string): string {
    for (const spec of this.scorerSpecs ?? []) {
      if (spec.name === name) return spec.version || UNVERSIONED_SCORER;
    }
    return UNVERSIONED_SCORER;
  }

  /** (threshold, direction) for ONE emitted metric, or null when it can't be resolved without
   *  guessing. A single scorer that emitted a SINGLE metric owns it even when the function name
   *  differs from the emitted Score name (name-agnostic). The moment that scorer emits a metric
   *  MAP, its one declared threshold cannot own every metric, so the emitted name must match the
   *  declaration — otherwise a `{threshold: 0.9}` scorer would stamp `passed` on an unrelated
   *  `latency_ms: 120`. With multiple scorers the same name-match rule applies. An unmatched
   *  metric returns null so the platform is told 'unknown', never a fabricated pass/fail. */
  private scorePolicy(
    name: string | null,
    singleEmission: boolean,
  ): [number | null, string] | null {
    const specs = this.scorerSpecs ?? [];
    const owner =
      specs.length === 1 && singleEmission
        ? specs[0]
        : (specs.find((s) => s.name === name) ?? null);
    if (!owner) return null;
    // RAW declared threshold (may be null): a numeric metric with no declared threshold is scored
    // but gets no fabricated pass/fail. Direction still defaults for a declared metric.
    return [
      owner.threshold != null ? owner.threshold : null,
      owner.direction != null ? owner.direction : 'higher_is_better',
    ];
  }

  /** SDK-computed pass/fail for one emitted metric, derived at serialization time and never stored
   *  on the Score. Boolean: true = pass. Numeric: compared against the OWNING scorer's
   *  threshold+direction (the same policy that decides the case status, so a single scorer's main
   *  score and its per-score `passed` always agree). Categorical, a 'none'-direction metric, or a
   *  numeric metric whose policy can't be resolved have no pass/fail -> null (never guessed). */
  private scorePassed(
    score: EvalItemResult['scores'][number],
    singleEmission = true,
  ): boolean | null {
    if (typeof score.value === 'boolean') return score.value;
    if (typeof score.value !== 'number') return null;
    const policy = this.scorePolicy(score.name, singleEmission);
    if (policy === null) return null;
    const [threshold, direction] = policy;
    if (threshold === null || direction === 'none') return null; // no declared threshold -> no verdict
    if (direction === 'lower_is_better') return score.value <= threshold;
    return score.value >= threshold; // higher_is_better (the default)
  }
}
