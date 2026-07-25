// src/eval/engine.ts — local evaluation engine.
// Parity with traceroot-py/traceroot/eval/engine.py: sync/async tasks and scorers, bounded
// concurrency, deterministic ordering, per-case and per-scorer failure isolation, timeout,
// deferred scores, run scorers, provenance, scorer metadata, and a trace-native span tree
// (evaluation-item -> task -> scorer) with standard span I/O + the versioned identity.

import { SpanAttributes } from '../constants';
import { TraceRoot } from '../traceroot';
import {
  startSpan,
  usingSpan,
  Span,
  _pushSuppressGlobalAutoInit as pushSuppressGlobalAutoInit,
  _popSuppressGlobalAutoInit as popSuppressGlobalAutoInit,
} from '../spans';
import type { Tracer } from '@opentelemetry/api';
import { evalTracer } from './tracer';
import { Dataset, DeferredScore, EvalCase, Score, ScorerContext } from './types';
import {
  EvalItemResult,
  EvalRunResult,
  RunDatasetRef,
  RunView,
  ScoreSummary,
  aggregateScores,
  makeRunResult,
} from './results';
import { EvalTransport, LocalTransport, RunHandle } from './transport';
import { PlatformTransport } from './platform';
import { collectRunProvenance } from './provenance';
import { declaredVersion, describeScorers } from './scorers';
import { newRunId } from './ids';
import { ConsoleProgress, printRunUrl, shouldShowProgress } from './progress';

export type TaskFn = (input: unknown) => unknown | Promise<unknown>;
export type ScoreLike =
  | number
  | boolean
  | string
  | Score
  | Score[]
  | DeferredScore
  | null
  | undefined;
export type ScorerFn = (ctx: ScorerContext) => ScoreLike | Promise<ScoreLike>;
export type RunScorerFn = (view: RunView) => ScoreLike | Promise<ScoreLike>;

export interface EvaluateOptions {
  name: string;
  /** The dataset (or inline cases) to run. `data` is a back-compat alias of `dataset`. */
  dataset?: Dataset | EvalCase[];
  data?: Dataset | EvalCase[];
  task: TaskFn;
  scorers: ScorerFn[];
  runScorers?: RunScorerFn[];
  candidateVersion?: string;
  datasetId?: string;
  maxConcurrency?: number;
  /** Bounds each case (seconds); a timeout is an isolated per-case error. */
  timeout?: number;
  metadata?: Record<string, unknown> | null;
  select?: (c: EvalCase) => boolean;
  environment?: string;
  /** Explicit transport wins over the default upload decision (e.g. baseline linking). */
  transport?: EvalTransport;
  /** Opt out of the upload-by-default behavior; keep the run local. */
  local?: boolean;
  /** A prior run to link as the baseline (auto-links baselineRunId when reporting). */
  baseline?: EvalRunResult;
  /**
   * Live console progress bar. Undefined = auto (on for an interactive
   * terminal, off when piped/CI); true/false forces it.
   */
  progress?: boolean;
  /** Internal hooks the CLI runner uses to stream per-case events. */
  onCaseStart?: (c: EvalCase) => void;
  onCaseComplete?: (item: EvalItemResult, durationMs: number) => void;
}

interface RunIdentity {
  name: string;
  datasetName: string;
  datasetId: string;
  datasetVersionId: string | null;
  candidateVersion: string | null;
  environment: string;
  runId: string | null;
  localRunId: string;
}

const INLINE_DATASET = '<inline>';
const EVAL_ATTR_CONTRACT_VERSION = '1';
const ZERO_TRACE_ID = /^0+$/;

function fmtError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function normalizeData(data: Dataset | EvalCase[]): EvalCase[] {
  const raw = data instanceof Dataset ? [...data] : data;
  return raw.map((c, i) => {
    if (typeof c !== 'object' || c === null || !('input' in c)) {
      throw new Error(`dataset item at index ${i} is missing required 'input'`);
    }
    return c.id === undefined || c.id === null ? { ...c, id: `case-${i}` } : c;
  });
}

function toScore(s: Score): Score {
  return {
    name: s.name,
    value: s.value,
    comment: s.comment ?? null,
    metadata: s.metadata ?? null,
    version: s.version ?? null,
  };
}

function assertScoreShape(s: unknown): asserts s is Score {
  if (typeof s !== 'object' || s === null || !('name' in s) || !('value' in s)) {
    throw new Error("scorer result object must contain 'name' and 'value'");
  }
}

function normalizeScoreLike(raw: ScoreLike, defaultName: string): Score[] {
  if (raw === null || raw === undefined) return [];
  if (raw instanceof DeferredScore) {
    // A deferred/human score is pending, never a numeric zero.
    return [
      {
        name: raw.name,
        value: 'pending',
        comment: raw.reason ?? null,
        metadata: { deferred: true },
      },
    ];
  }
  if (Array.isArray(raw)) {
    return raw.map((s) => {
      assertScoreShape(s);
      return toScore(s);
    });
  }
  if (typeof raw === 'object') {
    assertScoreShape(raw);
    return [toScore(raw)];
  }
  return [{ name: defaultName, value: raw, comment: null, metadata: null }];
}

/** Apply a scorer's declared version to produced scores that didn't set their own. */
function stampScorerVersion(scores: Score[], scorer: ScorerFn): Score[] {
  const declared = declaredVersion(scorer);
  if (declared === null) return scores;
  return scores.map((s) => (s.version != null ? s : { ...s, version: declared }));
}

function fnName(fn: (...args: never[]) => unknown, fallback: string): string {
  return fn.name && fn.name.length > 0 ? fn.name : fallback;
}

/** Bounded, order-preserving worker pool (backpressure: at most `limit` active). */
async function runBounded<T>(
  n: number,
  limit: number,
  worker: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(n);
  let next = 0;
  async function runner(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await worker(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, n) }, () => runner()));
  return results;
}

function setSpanAttr(
  span: Span,
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value === null || value === undefined) return;
  span.update({ attributes: { [key]: value } });
}

function setRootAttrs(root: Span, identity: RunIdentity, evalCase: EvalCase): void {
  const A = SpanAttributes;
  root.update({
    attributes: {
      [A.SPAN_TYPE]: 'evaluation',
      [A.EVAL_CONTRACT_VERSION]: EVAL_ATTR_CONTRACT_VERSION,
      [A.TRACEROOT_ENVIRONMENT]: identity.environment,
      [A.EVAL_ENVIRONMENT]: identity.environment,
      [A.EVAL_NAME]: identity.name,
      [A.EVAL_RUN_NAME]: identity.name,
      [A.EVAL_DATASET_NAME]: identity.datasetName,
      [A.EVAL_CASE_ID]: evalCase.id as string,
      [A.EVAL_HAS_EXPECTED]: evalCase.expected !== undefined && evalCase.expected !== null,
    },
  });
  setSpanAttr(root, A.EVAL_DATASET_ID, identity.datasetId);
  setSpanAttr(root, A.EVAL_DATASET_VERSION_ID, identity.datasetVersionId);
  setSpanAttr(root, A.EVAL_CANDIDATE_VERSION, identity.candidateVersion);
  setSpanAttr(root, A.EVAL_RUN_ID, identity.runId);
  setSpanAttr(root, A.EVAL_LOCAL_RUN_ID, identity.localRunId);
  setSpanAttr(root, A.EVAL_SOURCE_TRACE_ID, evalCase.sourceTraceId);
  setSpanAttr(root, A.EVAL_SOURCE_SPAN_ID, evalCase.sourceSpanId);
  setSpanAttr(root, A.EVAL_SCORE_TARGET_SPAN_ID, evalCase.scoreTargetSpanId);
}

function scorerOutputRepr(scores: Score[]): Array<Record<string, unknown>> {
  return scores.map((s) => ({ name: s.name, value: s.value, explanation: s.comment ?? null }));
}

function recordScorerSpan(span: Span, scores: Score[]): void {
  if (scores.length === 0) return;
  const first = scores[0];
  const attrs: Record<string, string | number | boolean> = {
    [SpanAttributes.EVAL_SCORE_VALUE]: first.value,
  };
  if (first.comment != null) attrs[SpanAttributes.EVAL_SCORE_COMMENT] = first.comment;
  span.update({ attributes: attrs });
}

async function withTimeout<T>(p: Promise<T>, timeout?: number): Promise<T> {
  if (timeout === undefined) return p;
  return Promise.race([
    p,
    new Promise<T>((_res, rej) =>
      setTimeout(() => rej(new Error(`TimeoutError: task exceeded ${timeout}s`)), timeout * 1000),
    ),
  ]);
}

async function runCase(
  evalCase: EvalCase,
  task: TaskFn,
  scorers: ScorerFn[],
  identity: RunIdentity,
  transport: EvalTransport,
  run: RunHandle,
  reporting: boolean,
  timeout: number | undefined,
  tracer: Tracer,
  onCaseStart?: (c: EvalCase) => void,
  onCaseComplete?: (item: EvalItemResult, durationMs: number) => void,
): Promise<EvalItemResult> {
  onCaseStart?.(evalCase);
  await transport.registerItem(run, evalCase);

  const startedAt = performance.now();
  const root = startSpan(
    { name: 'evaluation-item', type: 'evaluation', input: evalCase.input },
    tracer,
  );
  setRootAttrs(root, identity, evalCase);
  const rawTraceId = root.traceId;
  const traceId = reporting && !ZERO_TRACE_ID.test(rawTraceId) ? rawTraceId : null;

  const result = await usingSpan(root, async (): Promise<EvalItemResult> => {
    let output: unknown = null;
    let error: string | null = null;
    const scores: Score[] = [];
    const scorerErrors: Record<string, string> = {};

    const taskSpan = startSpan(
      {
        name: 'task',
        type: 'task',
        input: evalCase.input,
        attributes: {
          [SpanAttributes.EVAL_RUN_NAME]: identity.name,
          [SpanAttributes.EVAL_CASE_ID]: evalCase.id as string,
          [SpanAttributes.EVAL_TASK_NAME]: fnName(task, 'task'),
        },
      },
      tracer,
    );
    try {
      output = await usingSpan(taskSpan, () =>
        withTimeout(Promise.resolve(task(evalCase.input)), timeout),
      );
      taskSpan.update({ output });
    } catch (err) {
      error = fmtError(err);
      taskSpan.setError(err);
      taskSpan.update({ attributes: { [SpanAttributes.EVAL_ERROR]: error } });
    } finally {
      taskSpan.end();
    }

    if (error !== null) {
      root.setError(error);
      root.update({ output: error, attributes: { [SpanAttributes.EVAL_ERROR]: error } });
    } else {
      root.update({ output });
      const ctx: ScorerContext = {
        input: evalCase.input,
        output,
        expected: evalCase.expected ?? null,
        metadata: evalCase.metadata,
      };
      for (const scorer of scorers) {
        const name = fnName(scorer, 'scorer');
        const scorerInput: Record<string, unknown> = {
          candidate: output,
          expected: evalCase.expected ?? null,
        };
        if (evalCase.scoreTargetSpanId) scorerInput.target_span_id = evalCase.scoreTargetSpanId;
        const scorerSpan = startSpan(
          {
            name,
            type: 'scorer',
            input: scorerInput,
            attributes: {
              [SpanAttributes.EVAL_RUN_NAME]: identity.name,
              [SpanAttributes.EVAL_SCORER_NAME]: name,
            },
          },
          tracer,
        );
        try {
          const raw = await usingSpan(scorerSpan, () => Promise.resolve(scorer(ctx)));
          const produced = stampScorerVersion(normalizeScoreLike(raw, name), scorer);
          scores.push(...produced);
          recordScorerSpan(scorerSpan, produced);
          if (produced.length > 0) scorerSpan.update({ output: scorerOutputRepr(produced) });
        } catch (err) {
          scorerErrors[name] = fmtError(err);
          scorerSpan.setError(err);
          scorerSpan.update({
            output: scorerErrors[name],
            attributes: { [SpanAttributes.EVAL_ERROR]: scorerErrors[name] },
          });
        } finally {
          scorerSpan.end();
        }
      }
    }

    return {
      caseId: evalCase.id as string,
      input: evalCase.input,
      output,
      expected: evalCase.expected ?? null,
      scores,
      scorerErrors,
      error,
      traceId,
      durationMs: Math.max(0, performance.now() - startedAt),
    };
  });

  root.end();
  await transport.recordItemResult(run, result);
  await transport.recordScores(run, result.caseId, result.scores);
  onCaseComplete?.(result, result.durationMs ?? 0);
  return result;
}

/** Whole-run scorers over the completed items. Errors are isolated per scorer. */
async function runRunScorers(
  runScorers: RunScorerFn[] | undefined,
  name: string,
  itemResults: EvalItemResult[],
  summary: Record<string, ScoreSummary>,
): Promise<{ runScores: Score[]; runScorerErrors: Record<string, string> }> {
  const runScores: Score[] = [];
  const runScorerErrors: Record<string, string> = {};
  if (!runScorers || runScorers.length === 0) return { runScores, runScorerErrors };
  const view: RunView = { name, itemResults, scoreSummary: summary };
  for (const rs of runScorers) {
    const rname = fnName(rs, 'run_scorer');
    try {
      const raw = await Promise.resolve(rs(view));
      runScores.push(...normalizeScoreLike(raw, rname));
    } catch (err) {
      runScorerErrors[rname] = fmtError(err);
    }
  }
  return { runScores, runScorerErrors };
}

/**
 * Reporting default (matches Braintrust/Langfuse/Laminar): upload when credentials + a
 * platform dataset (pulled/pushed, or an explicit datasetId) exist. Returns null to stay
 * local — no credentials, or a purely local dataset the SDK cannot create server-side.
 */
function autoTransport(
  data: Dataset | EvalCase[],
  datasetId: string | undefined,
  scorers: ScorerFn[],
  candidateVersion: string | undefined,
  environment: string | undefined,
  baselineRunId: string | null,
): EvalTransport | null {
  let effectiveId = datasetId;
  let versionId: string | null = null;
  if (data instanceof Dataset) {
    versionId = data.datasetVersionId ?? null;
    if (effectiveId === undefined && data.datasetId && versionId !== null)
      effectiveId = data.datasetId;
  }
  if (!effectiveId) return null;
  const { apiKey } = TraceRoot.resolveCredentials();
  if (!apiKey) return null;
  return new PlatformTransport(effectiveId, {
    scorerNames: scorers.map((s) => fnName(s, 'scorer')),
    candidateVersion: candidateVersion ?? null,
    environment,
    datasetVersionId: versionId,
    baselineRunId,
  });
}

/** Run an evaluation. Async-first; `evaluate` is an alias of `evaluateAsync`. */
export async function evaluateAsync(options: EvaluateOptions): Promise<EvalRunResult> {
  const { name, task, scorers, maxConcurrency = 10, transport, candidateVersion } = options;
  const environment = options.environment ?? 'evaluation';
  const data = options.dataset ?? options.data;

  if (!name || name.trim().length === 0) throw new Error("evaluate() requires a non-empty 'name'");
  if (data === undefined) throw new Error("evaluate() requires 'dataset' (or the 'data' alias)");
  if (typeof task !== 'function') throw new Error("'task' must be a function");
  if (!scorers || scorers.length === 0) throw new Error('evaluate() requires at least one scorer');
  for (const s of scorers) {
    if (typeof s !== 'function') throw new Error(`scorer ${String(s)} is not a function`);
  }
  if (maxConcurrency < 1) throw new Error("'maxConcurrency' must be >= 1");

  let cases = normalizeData(data);
  if (options.select) cases = cases.filter(options.select);
  if (cases.length === 0) throw new Error('evaluate() requires at least one case to run');

  const datasetName = data instanceof Dataset ? data.name : INLINE_DATASET;
  const snapshotRevision =
    data instanceof Dataset ? data.snapshot().revision : `local-${cases.length}`;
  const runMetadata = collectRunProvenance(options.metadata, { detectDirty: false });

  // Reporting decision: explicit transport wins; else local:true keeps local; else upload
  // when credentials + a platform dataset exist.
  let active: EvalTransport;
  if (transport !== undefined) {
    active = transport;
  } else if (options.local) {
    active = new LocalTransport();
  } else {
    const baselineRunId = options.baseline?.runId ?? null;
    active =
      autoTransport(
        data,
        options.datasetId,
        scorers,
        candidateVersion,
        environment,
        baselineRunId,
      ) ?? new LocalTransport();
  }

  // Forward scorer comparison metadata to a transport that accepts specs (before createRun).
  if ('scorerSpecs' in active && (active as PlatformTransport).scorerSpecs === undefined) {
    (active as PlatformTransport).scorerSpecs = describeScorers(scorers);
  }

  const reporting = active.reportsTraces === true;
  // Eval structural spans go through this tracer. For a local run it is a private,
  // non-exporting tracer that also avoids initializing the global exporting provider,
  // so a local eval never exports spans even when TRACEROOT_API_KEY is set.
  const evalSpanTracer = evalTracer(reporting);
  const localRunId = newRunId();
  const run = await active.createRun(name, datasetName, runMetadata);

  const identity: RunIdentity = {
    name,
    datasetName,
    datasetId: options.datasetId ?? (data instanceof Dataset ? data.datasetId : 'ds_inline'),
    datasetVersionId: data instanceof Dataset ? (data.datasetVersionId ?? null) : null,
    candidateVersion: candidateVersion ?? null,
    environment,
    runId: active.runId ?? null,
    localRunId,
  };

  // Live console progress bar (local presentation only; auto-on for an
  // interactive terminal, off when piped/CI). Composes with any caller hooks.
  let reporter: ConsoleProgress | undefined;
  let onCaseComplete = options.onCaseComplete;
  if (shouldShowProgress(options.progress)) {
    reporter = new ConsoleProgress(cases.length, name);
    reporter.start();
    const next = options.onCaseComplete;
    onCaseComplete = (item, durationMs) => {
      reporter!.onCaseComplete(item, durationMs);
      next?.(item, durationMs);
    };
  }

  // For a local run, suppress lazy global-provider init for the duration so nested
  // application spans (user startSpan/observe, auto-instrumentation) created inside a
  // task/scorer cannot bring up the OTLP exporter and leak. No-op for a reported run.
  if (!reporting) pushSuppressGlobalAutoInit();
  let itemResults: EvalItemResult[];
  try {
    itemResults = await runBounded(cases.length, maxConcurrency, (i) =>
      runCase(
        cases[i],
        task,
        scorers,
        identity,
        active,
        run,
        reporting,
        options.timeout,
        evalSpanTracer,
        options.onCaseStart,
        onCaseComplete,
      ),
    );
  } finally {
    if (!reporting) popSuppressGlobalAutoInit();
    reporter?.finish();
  }
  const uploadState = await active.finishRun(run);

  const summary = aggregateScores(itemResults);
  const { runScores, runScorerErrors } = await runRunScorers(
    options.runScorers,
    name,
    itemResults,
    summary,
  );

  const datasetRef: RunDatasetRef = {
    datasetId: identity.datasetId,
    revision: snapshotRevision,
    datasetVersionId: identity.datasetVersionId,
    caseCount: cases.length,
  };

  const result = makeRunResult(name, itemResults, uploadState, {
    localRunId,
    runId: active.runId ?? null,
    candidateVersion: candidateVersion ?? null,
    dataset: datasetRef,
    metadata: runMetadata,
    baseline: options.baseline ?? null,
    runScores,
    runScorerErrors,
  });

  // When the bar was shown (interactive), print a closing block: the
  // candidate-vs-baseline comparison when a baseline exists (it carries the run
  // link), otherwise just the clickable run link. Off-terminal callers read the
  // returned result instead.
  if (reporter) {
    if (options.baseline) {
      process.stderr.write(result.comparisonReport(options.baseline) + '\n');
    } else if (uploadState.dashboardUrl) {
      printRunUrl(uploadState.dashboardUrl);
    }
  }

  return result;
}

/** Alias of {@link evaluateAsync}. TypeScript has no blocking mode; both return a Promise. */
export const evaluate = evaluateAsync;
