// src/eval/results.ts — result/summary types + aggregation.
// Parity with traceroot-py/traceroot/eval/results.py. The serialized artifact (toJSON /
// save) uses the SAME snake_case shape as Python so runs are cross-loadable and the runner
// run.json is readable; in-memory fields are idiomatic camelCase.

import { readFileSync, writeFileSync } from 'node:fs';

import type { Score } from './types';

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

/** The read-only view passed to a whole-run scorer. */
export interface RunView {
  name: string;
  itemResults: EvalItemResult[];
  scoreSummary: Record<string, ScoreSummary>;
}

/**
 * Derive passed | failed | errored | not_scored for one item. A task error is 'errored'
 * (distinct from a scorer error). A case with no numeric/boolean score is 'not_scored'
 * (distinct from a score of zero).
 */
export function caseStatus(item: EvalItemResult, passThreshold = 1.0): string {
  if (item.error !== null) return 'errored';
  let main: number | null = null;
  for (const s of item.scores) {
    if (typeof s.value === 'boolean') {
      main = s.value ? 1.0 : 0.0;
      break;
    }
    if (typeof s.value === 'number') {
      main = s.value;
      break;
    }
  }
  if (main === null) return 'not_scored';
  return main >= passThreshold ? 'passed' : 'failed';
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
      if (typeof score.value === 'number' || typeof score.value === 'boolean') {
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
  runScores?: Score[];
  runScorerErrors?: Record<string, string>;
  metadata?: Record<string, unknown> | null;
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
  runScores: Score[];
  runScorerErrors: Record<string, string>;
  metadata: Record<string, unknown> | null;

  constructor(init: EvalRunResultInit) {
    this.name = init.name;
    this.itemResults = init.itemResults;
    this.scoreSummary = init.scoreSummary;
    this.uploadState = init.uploadState;
    this.localRunId = init.localRunId ?? '';
    this.candidateVersion = init.candidateVersion ?? null;
    this.dataset = init.dataset ?? null;
    this.runId = init.runId ?? null;
    this.runScores = init.runScores ?? [];
    this.runScorerErrors = init.runScorerErrors ?? {};
    this.metadata = init.metadata ?? null;
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
  failures(): EvalItemResult[] {
    return this.byStatus('failed');
  }
  errors(): EvalItemResult[] {
    return this.itemResults.filter(
      (it) => it.error !== null || Object.keys(it.scorerErrors).length > 0,
    );
  }
  get caseCount(): number {
    return this.itemResults.length;
  }
  get passed(): number {
    return this.byStatus('passed').length;
  }
  get failed(): number {
    return this.byStatus('failed').length;
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
  get scoredCount(): number {
    return this.passed + this.failed;
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
        scored_count: this.scoredCount,
        passed: this.passed,
        failed: this.failed,
        not_scored: this.notScored,
        task_errors: this.taskErrorCount,
        scorer_errors: this.scorerErrorCount,
      },
      item_results: this.itemResults.map(itemToJSON),
      score_summary: Object.fromEntries(
        Object.entries(this.scoreSummary).map(([k, v]) => [k, { ...v }]),
      ),
      run_scores: this.runScores.map(scoreToJSON),
      run_scorer_errors: this.runScorerErrors,
      // fromJSON() reads `upload`, so write it here too — otherwise a save/load round trip loses
      // the run's status and dashboard URL.
      upload: { status: this.uploadState.status, dashboard_url: this.uploadState.dashboardUrl },
      metadata: this.metadata,
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
      uploadState: {
        status: d.upload?.status ?? 'uploaded',
        dashboardUrl: d.upload?.dashboard_url ?? null,
      },
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
      runScores: (d.run_scores ?? []).map((s: any) => ({ ...s, version: s.version ?? null })),
      runScorerErrors: d.run_scorer_errors ?? {},
      metadata: d.metadata ?? null,
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
      uploadState: {
        status: d.upload?.status ?? 'uploaded',
        dashboardUrl: d.upload?.dashboard_url ?? null,
      },
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
        scorerNames: Object.keys(this.scoreSummary),
        candidateVersion: this.candidateVersion,
        datasetVersionId: this.dataset.datasetVersionId,
        clientRunId: this.localRunId,
      });
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

  summary(): string {
    const head =
      `EvalRunResult(name=${this.name}, cases=${this.caseCount}, passed=${this.passed}, ` +
      `failed=${this.failed}, not_scored=${this.notScored}, ` +
      `task_errors=${this.taskErrorCount}, upload=${this.uploadState.status})`;
    const lines = [head];
    for (const [name, s] of Object.entries(this.scoreSummary)) {
      const mean = s.mean === null ? 'n/a' : String(s.mean);
      lines.push(`  ${name}: mean=${mean} count=${s.count}`);
    }
    return lines.join('\n');
  }
}

export interface MakeRunResultOptions {
  runId?: string | null;
  candidateVersion?: string | null;
  dataset?: RunDatasetRef | null;
  localRunId?: string;
  metadata?: Record<string, unknown> | null;
  runScores?: Score[];
  runScorerErrors?: Record<string, string>;
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
