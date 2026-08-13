// src/eval/results.ts — result/summary types + aggregation.
// Parity with traceroot-py/traceroot/eval/results.py. The serialized artifact (toJSON /
// save) uses the SAME snake_case shape as Python so runs are cross-loadable and the runner
// run.json is readable; in-memory fields are idiomatic camelCase.

import { readFileSync, writeFileSync } from 'node:fs';

import type { Score } from './types';
import type { ScorerSpec } from './platform';

// --- Python-identical rendering for summary() --------------------------------
/** The characters Python's `repr()` escapes rather than prints: exactly `str.isprintable()`'s
 *  "Other" and "Separator" categories, minus the ASCII space. Escaping only \n\r\t left every
 *  other control character (0x00-0x1f, DEL, the C1 block, zero-width/bidi marks) rendering
 *  literally, so summary() stopped being byte-identical to Python for such a name. */
const PY_NONPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** The numeric escape CPython emits for a non-printable code point: `\xNN` below 0x100,
 *  `\uNNNN` below 0x10000, `\UNNNNNNNN` above. */
function pyEscapeCodePoint(cp: number): string {
  if (cp < 0x100) return '\\x' + cp.toString(16).padStart(2, '0');
  if (cp < 0x10000) return '\\u' + cp.toString(16).padStart(4, '0');
  return '\\U' + cp.toString(16).padStart(8, '0');
}

/** Python `repr()` of a string: single quotes, switching to double quotes when the value
 *  contains a single quote (and no double quote). */
function pyRepr(s: string): string {
  // The quote is chosen from the RAW value, exactly as CPython does, before any escaping.
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = '';
  for (const ch of s) {
    if (ch === '\\') body += '\\\\';
    else if (ch === quote) body += '\\' + ch;
    // The three short forms repr keeps short; every other control char takes a numeric escape.
    else if (ch === '\n') body += '\\n';
    else if (ch === '\r') body += '\\r';
    else if (ch === '\t') body += '\\t';
    // The ASCII space is the one Separator Python calls printable; every other one is escaped.
    else if (ch !== ' ' && PY_NONPRINTABLE.test(ch))
      body += pyEscapeCodePoint(ch.codePointAt(0) as number);
    else body += ch;
  }
  return quote + body + quote;
}

/** Python's `f"{v:.4g}"` — 4 significant digits, trailing zeros stripped, two-digit signed
 *  exponent outside the fixed range. */
function formatG4(v: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
  const sci = v.toExponential(3); // e.g. "8.333e-1"
  const exp = Number(sci.slice(sci.indexOf('e') + 1));
  const strip = (t: string) => (t.includes('.') ? t.replace(/\.?0+$/, '') : t);
  if (exp >= -4 && exp < 4) return strip(v.toFixed(Math.max(0, 3 - exp)));
  const mantissa = strip(sci.slice(0, sci.indexOf('e')));
  const sign = exp < 0 ? '-' : '+';
  return `${mantissa}e${sign}${String(Math.abs(exp)).padStart(2, '0')}`;
}

/** The outcome of running one case: task output plus every scorer result. */
export interface EvalItemResult {
  caseId: string;
  input: unknown;
  output: unknown;
  expected: unknown;
  scores: Score[];
  scorerErrors: Record<string, string>;
  error: string | null;
  traceId: string | null;
  /** Total wall-clock for this case (task + its scorers), ms; null when unknown. */
  durationMs: number | null;
}

function scoreToJSON(s: Score): Record<string, unknown> {
  return {
    name: s.name,
    value: s.value,
    comment: s.comment ?? null,
    metadata: s.metadata ?? null,
    version: s.version ?? null,
  };
}

function itemToJSON(it: EvalItemResult): Record<string, unknown> {
  return {
    case_id: it.caseId,
    input: it.input,
    output: it.output,
    expected: it.expected,
    scores: it.scores.map(scoreToJSON),
    scorer_errors: it.scorerErrors,
    error: it.error,
    trace_id: it.traceId,
    duration_ms: it.durationMs,
  };
}

function itemFromJSON(d: Record<string, any>): EvalItemResult {
  return {
    caseId: d.case_id,
    input: d.input ?? null,
    output: d.output ?? null,
    expected: d.expected ?? null,
    scores: (d.scores ?? []).map((s: any) => ({
      name: s.name,
      value: s.value,
      comment: s.comment ?? null,
      metadata: s.metadata ?? null,
      version: s.version ?? null,
    })),
    scorerErrors: d.scorer_errors ?? {},
    error: d.error ?? null,
    traceId: d.trace_id ?? null,
    durationMs: d.duration_ms ?? null,
  };
}

/** Explicit record of the run's platform persistence. Never silent. */
export interface UploadState {
  status: 'uploaded';
  dashboardUrl: string | null;
  /** Per-case result POSTs that failed and were dropped (reporting is best-effort, so the run
   *  still completes). Counted so a run that reports "uploaded" with silently-missing results is
   *  detectable instead of looking green. The engine always sets it. */
  failedResultCount?: number;
}

/** Read an `upload` block back from either artifact shape (Python: `UploadState(**d["upload"])`).
 *  Shared so both readers restore the dropped-result count, not just the status/URL. */
function uploadStateFromJSON(d: Record<string, any> | undefined | null): UploadState {
  return {
    status: d?.status ?? 'uploaded',
    dashboardUrl: d?.dashboard_url ?? null,
    failedResultCount: d?.failed_result_count ?? 0,
  };
}

/** Immutable description of the exact dataset version/content a run executed. */
export interface RunDatasetRef {
  datasetId: string;
  revision: string;
  datasetVersionId: string | null;
  caseCount: number;
}

/** Aggregate of one score name across a run. */
export interface ScoreSummary {
  name: string;
  mean: number | null;
  count: number;
}

/**
 * Derive the per-case status: 'errored' when the case had a task error OR any scorer error,
 * otherwise 'not_scored'. There is no headline pass/fail at the case level — the per-metric
 * verdict lives on each Score's `passed` (see PlatformTransport), never on the case status.
 */
export function caseStatus(item: EvalItemResult): string {
  if (item.error !== null || Object.keys(item.scorerErrors).length > 0) return 'errored';
  return 'not_scored';
}

/**
 * Aggregate every produced score by name. Numeric and boolean values contribute to `mean`;
 * categorical (string) values contribute to `count` only. `mean` is `null` when a name has
 * no numeric values. Scores never produced (scorer errored) do not appear.
 */
export function aggregateScores(itemResults: EvalItemResult[]): Record<string, ScoreSummary> {
  const numSum: Record<string, number> = {};
  const numCount: Record<string, number> = {};
  const totalCount: Record<string, number> = {};
  const order: string[] = [];

  for (const item of itemResults) {
    for (const score of item.scores) {
      if (!(score.name in totalCount)) {
        order.push(score.name);
        totalCount[score.name] = 0;
      }
      totalCount[score.name] += 1;
      // A non-finite value (NaN/Infinity) must not fold into the mean: it would make the local
      // aggregate disagree with the wire (where a non-finite score is errored) and .summary(), and
      // it serializes to `null` here while Python writes a bare `NaN` — the same run then differs
      // across surfaces. Exclude it from the numeric aggregate; it still counts as a produced score.
      if (
        (typeof score.value === 'number' || typeof score.value === 'boolean') &&
        Number.isFinite(Number(score.value))
      ) {
        numSum[score.name] = (numSum[score.name] ?? 0) + Number(score.value);
        numCount[score.name] = (numCount[score.name] ?? 0) + 1;
      }
    }
  }

  const summary: Record<string, ScoreSummary> = {};
  for (const name of order) {
    const n = numCount[name] ?? 0;
    summary[name] = { name, mean: n ? numSum[name] / n : null, count: totalCount[name] };
  }
  return summary;
}

export interface EvalRunResultInit {
  name: string;
  itemResults: EvalItemResult[];
  scoreSummary: Record<string, ScoreSummary>;
  uploadState: UploadState;
  localRunId?: string;
  candidateVersion?: string | null;
  dataset?: RunDatasetRef | null;
  runId?: string | null;
  metadata?: Record<string, unknown> | null;
  scorerSpecs?: ScorerSpec[] | null;
}

/** The full, immutable result of an evaluation run. */
export class EvalRunResult {
  name: string;
  itemResults: EvalItemResult[];
  scoreSummary: Record<string, ScoreSummary>;
  uploadState: UploadState;
  localRunId: string;
  candidateVersion: string | null;
  dataset: RunDatasetRef | null;
  runId: string | null;
  metadata: Record<string, unknown> | null;
  // Declared scorer policy (name/version/value_type/direction/threshold) captured at run time.
  // Retained so an explicit upload() re-declares each metric's threshold/direction to the platform
  // instead of re-registering policy-less — otherwise a re-upload's per-score `passed` verdicts
  // would silently disagree with the original run's.
  scorerSpecs: ScorerSpec[] | null;

  constructor(init: EvalRunResultInit) {
    this.name = init.name;
    this.itemResults = init.itemResults;
    this.scoreSummary = init.scoreSummary;
    this.uploadState = init.uploadState;
    this.localRunId = init.localRunId ?? '';
    this.candidateVersion = init.candidateVersion ?? null;
    this.dataset = init.dataset ?? null;
    this.runId = init.runId ?? null;
    this.metadata = init.metadata ?? null;
    this.scorerSpecs = init.scorerSpecs ?? null;
  }

  // --- inspection ---
  get results(): EvalItemResult[] {
    // Defensive copy: the result is contractually immutable, so callers can't add/remove items
    // and desynchronize the counts/scoreSummary computed at construction.
    return [...this.itemResults];
  }
  private byStatus(status: string): EvalItemResult[] {
    return this.itemResults.filter((it) => caseStatus(it) === status);
  }
  errors(): EvalItemResult[] {
    return this.itemResults.filter(
      (it) => it.error !== null || Object.keys(it.scorerErrors).length > 0,
    );
  }
  get caseCount(): number {
    return this.itemResults.length;
  }
  // caseStatus is errored | not_scored — there is no case-level pass/fail to count, so these
  // are the only two status tallies (Python results.py `errored`/`not_scored`).
  get errored(): number {
    return this.byStatus('errored').length;
  }
  get notScored(): number {
    return this.byStatus('not_scored').length;
  }
  get taskErrorCount(): number {
    return this.itemResults.filter((it) => it.error !== null).length;
  }
  get scorerErrorCount(): number {
    return this.itemResults.reduce((n, it) => n + Object.keys(it.scorerErrors).length, 0);
  }

  // --- serialization (Python-identical snake_case artifact) ---
  toJSON(): Record<string, unknown> {
    return {
      schema_version: '1',
      name: this.name,
      local_run_id: this.localRunId,
      run_id: this.runId,
      candidate_version: this.candidateVersion,
      dataset: this.dataset
        ? {
            dataset_id: this.dataset.datasetId,
            revision: this.dataset.revision,
            dataset_version_id: this.dataset.datasetVersionId,
            case_count: this.dataset.caseCount,
          }
        : null,
      counts: {
        case_count: this.caseCount,
        errored: this.errored,
        not_scored: this.notScored,
        task_errors: this.taskErrorCount,
        scorer_errors: this.scorerErrorCount,
      },
      item_results: this.itemResults.map(itemToJSON),
      score_summary: Object.fromEntries(
        Object.entries(this.scoreSummary).map(([k, v]) => [k, { ...v }]),
      ),
      // fromJSON() reads `upload`, so write it here too — otherwise a save/load round trip loses
      // the run's status and dashboard URL. `failed_result_count` rides along (Python's
      // UploadState.to_dict() writes the same key): without it a reloaded run that silently
      // dropped result POSTs reads as fully uploaded and the partial-upload warning disappears.
      upload: {
        status: this.uploadState.status,
        dashboard_url: this.uploadState.dashboardUrl,
        failed_result_count: this.uploadState.failedResultCount ?? 0,
      },
      metadata: this.metadata,
      scorer_specs: this.scorerSpecs,
    };
  }

  /** Reader for BOTH artifact shapes: EvalRunResult.save() and the runner run.json. */
  static fromJSON(d: Record<string, any>): EvalRunResult {
    if (d.kind === 'eval_run' || ('cases' in d && !('item_results' in d))) {
      return EvalRunResult.fromRunnerArtifact(d);
    }
    const ds = d.dataset;
    return new EvalRunResult({
      name: d.name,
      itemResults: (d.item_results ?? []).map(itemFromJSON),
      scoreSummary: Object.fromEntries(
        Object.entries(d.score_summary ?? {}).map(([k, v]: [string, any]) => [k, { ...v }]),
      ),
      uploadState: uploadStateFromJSON(d.upload),
      localRunId: d.local_run_id ?? '',
      candidateVersion: d.candidate_version ?? null,
      dataset: ds
        ? {
            datasetId: ds.dataset_id,
            revision: ds.revision,
            datasetVersionId: ds.dataset_version_id ?? null,
            caseCount: ds.case_count,
          }
        : null,
      runId: d.run_id ?? null,
      metadata: d.metadata ?? null,
      scorerSpecs: d.scorer_specs ?? null,
    });
  }

  private static fromRunnerArtifact(d: Record<string, any>): EvalRunResult {
    const items: EvalItemResult[] = (d.cases ?? []).map((c: any) => ({
      caseId: c.case_id,
      input: null,
      output: null,
      expected: null,
      scores: (c.scores ?? []).map((s: any) => ({
        name: s.scorer_name,
        value: s.value,
        comment: s.explanation ?? null,
        version: s.scorer_version ?? null,
      })),
      scorerErrors: Object.fromEntries(
        (c.scorer_errors ?? []).map((se: any) => [se.scorer_name, se.message ?? '']),
      ),
      error: c.task_error ?? null,
      traceId: c.trace_id ?? null,
      durationMs: c.duration_ms ?? null,
    }));
    const ds = d.dataset;
    return new EvalRunResult({
      name: d.evaluation_name ?? d.name ?? '',
      itemResults: items,
      scoreSummary: Object.fromEntries(
        Object.entries(d.scores ?? {}).map(([k, v]: [string, any]) => [k, { ...v }]),
      ),
      uploadState: uploadStateFromJSON(d.upload),
      localRunId: d.local_run_id ?? '',
      candidateVersion: d.candidate_version ?? null,
      dataset: ds
        ? {
            datasetId: ds.dataset_id,
            revision: ds.revision,
            datasetVersionId: ds.dataset_version_id ?? null,
            caseCount: ds.case_count,
          }
        : null,
      runId: d.run_id ?? null,
      metadata: d.metadata ?? null,
    });
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.toJSON()));
  }

  static load(path: string): EvalRunResult {
    return EvalRunResult.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
  }

  /**
   * Explicitly upload this retained run's results/scores (idempotent). Replays the item
   * results through the reporting layer, preserving test_case_ids; localRunId is the
   * idempotency key. Without a transport, a PlatformTransport is built from the dataset ref
   * + scorer names (needs credentials).
   */
  async upload(transport?: import('./transport').EvalTransport): Promise<EvalRunResult> {
    let active = transport;
    if (!active) {
      const { PlatformTransport } = await import('./platform');
      if (!this.dataset)
        throw new Error('run.upload() needs a dataset ref or an explicit transport');
      active = new PlatformTransport(this.dataset.datasetId, {
        // Include scorers that produced scores AND ones that errored on every case (absent
        // from scoreSummary), so an all-failing scorer still appears in run registration.
        scorerNames: [
          ...new Set([
            ...Object.keys(this.scoreSummary),
            ...this.itemResults.flatMap((it) => it.scores.map((s) => s.name)),
            ...this.itemResults.flatMap((it) => Object.keys(it.scorerErrors)),
          ]),
        ],
        candidateVersion: this.candidateVersion,
        datasetVersionId: this.dataset.datasetVersionId,
        clientRunId: this.localRunId,
        // Re-declare each metric's threshold/direction (captured at run time) so a re-upload's
        // per-score `passed` matches the original run instead of registering policy-less. null (an
        // older/loaded run without specs) falls back to names.
        scorerSpecs: this.scorerSpecs ?? undefined,
      });
    } else if (this.scorerSpecs && 'scorerSpecs' in active) {
      // An EXPLICIT transport gets the same retained policy the auto-built one above gets: without
      // it a caller-supplied PlatformTransport registers policy-less and every replayed numeric
      // score comes back without its `passed` verdict. Feature-detected rather than instanceof'd
      // so no import of ./platform is needed, and specs the caller set themselves always win.
      const withSpecs = active as { scorerSpecs?: ScorerSpec[] };
      if (withSpecs.scorerSpecs === undefined) withSpecs.scorerSpecs = this.scorerSpecs;
    }
    const datasetName = this.dataset ? this.dataset.datasetId : '<inline>';
    // Preserve the run's metadata/provenance on re-upload instead of registering with null.
    const run = await active.createRun(this.name, datasetName, this.metadata, this.localRunId);
    for (const item of this.itemResults) {
      await active.recordItemResult(run, item);
      await active.recordScores(run, item.caseId, item.scores);
    }
    this.uploadState = await active.finishRun(run, null);
    this.runId = active.runId ?? null;
    return this;
  }

  /** Byte-identical to Python's `EvalRunResult.__str__` — same field order, `repr`-quoted run
   *  name, and `%.4g` means — so one harness can diff two SDKs' output verbatim. */
  summary(): string {
    const head =
      `EvalRunResult(name=${pyRepr(this.name)}, cases=${this.caseCount}, errored=${this.errored}, ` +
      `not_scored=${this.notScored}, ` +
      `task_errors=${this.taskErrorCount}, upload=${this.uploadState.status})`;
    const lines = [head];
    const [passed, judged] = this.passTally();
    for (const [name, s] of Object.entries(this.scoreSummary)) {
      const mean = s.mean === null ? 'n/a' : formatG4(s.mean);
      const n = judged[name] ?? 0;
      const passSeg = n ? ` pass=${passed[name] ?? 0}/${n}` : '';
      lines.push(`  ${name}: mean=${mean}${passSeg} count=${s.count}`);
    }
    return lines.join('\n');
  }

  /** (passed, judged) counts per metric for {@link summary}. A score is JUDGED when it has a bool
   *  value, or a numeric value AND its owning scorer declared a threshold + direction — the SAME
   *  rule the platform uses for per-score `passed`. Metrics with no declared policy get no
   *  pass-rate, only a count. Byte-identical to Python's `_pass_tally`. */
  private passTally(): [Record<string, number>, Record<string, number>] {
    const specs = this.scorerSpecs ?? [];
    const byName: Record<string, ScorerSpec> = {};
    for (const s of specs) byName[s.name] = s;
    const passed: Record<string, number> = {};
    const judged: Record<string, number> = {};
    for (const item of this.itemResults) {
      const single = item.scores.length === 1;
      for (const score of item.scores) {
        // Resolve the owner EXACTLY as PlatformTransport._score_policy does.
        const owner = specs.length === 1 && single ? specs[0] : byName[score.name];
        const verdict = scoreVerdict(score.value, owner);
        if (verdict === null) continue;
        judged[score.name] = (judged[score.name] ?? 0) + 1;
        if (verdict) passed[score.name] = (passed[score.name] ?? 0) + 1;
      }
    }
    return [passed, judged];
  }
}

/** Whether one score passes, given its ALREADY-RESOLVED owning scorer spec. Parity with
 *  PlatformTransport._score_passed: a bool value IS its verdict; a numeric value passes iff it
 *  clears the owner's declared threshold in its declared direction (default higher_is_better). null
 *  for a non-finite value, no owner, or an owner with no threshold / 'none' direction. */
function scoreVerdict(value: unknown, owner: ScorerSpec | undefined): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!owner) return null;
  const threshold = owner.threshold;
  const direction = owner.direction ?? 'higher_is_better';
  if (threshold == null || direction === 'none') return null;
  return direction === 'lower_is_better' ? value <= threshold : value >= threshold;
}

export interface MakeRunResultOptions {
  runId?: string | null;
  candidateVersion?: string | null;
  dataset?: RunDatasetRef | null;
  localRunId?: string;
  metadata?: Record<string, unknown> | null;
  scorerSpecs?: ScorerSpec[] | null;
}

/** Build an EvalRunResult (computes the score summary). */
export function makeRunResult(
  name: string,
  itemResults: EvalItemResult[],
  uploadState: UploadState,
  opts: MakeRunResultOptions = {},
): EvalRunResult {
  return new EvalRunResult({
    name,
    itemResults,
    scoreSummary: aggregateScores(itemResults),
    uploadState,
    ...opts,
  });
}
