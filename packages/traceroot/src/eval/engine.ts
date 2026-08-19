// src/eval/engine.ts — evaluation engine.
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
  _pushSuppressGlobalAutoInit,
  _popSuppressGlobalAutoInit,
} from '../spans';
import type { Tracer } from '@opentelemetry/api';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { evalTracer } from './tracer';
import { Dataset, DatasetSnapshot, DeferredScore, EvalCase, Score, ScorerContext } from './types';
import {
  EvalItemResult,
  EvalRunResult,
  RunDatasetRef,
  makeRunResult,
  UploadState,
} from './results';
import { EvalCompletionError, EvalTransport, FakeTransport, RunHandle } from './transport';
import { PlatformTransport, pinnedContentChanged, rememberPinnedContent } from './platform';
import { PlatformDatasetSync } from './dataset_sync';
import { collectRunProvenance } from './provenance';
import { declaredVersion, describeScorers, scorerName } from './scorers';
import { newRunId } from './ids';
import { ConsoleProgress, printRunUrl, shouldShowProgress } from './progress';

export type TaskFn = (input: unknown) => unknown | Promise<unknown>;
export type ScoreLike =
  | number
  | boolean
  | string
  | Score
  | Score[]
  | Record<string, number | boolean | string> // a metric -> value map (one Score per entry)
  | DeferredScore
  | null
  | undefined;
export type ScorerFn = (ctx: ScorerContext) => ScoreLike | Promise<ScoreLike>;

export interface EvaluateOptions {
  name: string;
  /** The dataset, an immutable snapshot of one, or inline cases. `data` aliases `dataset`. */
  dataset?: Dataset | DatasetSnapshot | EvalCase[];
  data?: Dataset | DatasetSnapshot | EvalCase[];
  task: TaskFn;
  scorers: ScorerFn[];
  candidateVersion?: string;
  datasetId?: string;
  /**
   * The stable identity runs are grouped by, separate from the display `name` (the same split as
   * a scorer's `key`): set it to keep one history across a rename, or to group the TypeScript and
   * Python runs of one evaluation. Defaults to `name`.
   */
  evaluationKey?: string;
  maxConcurrency?: number;
  /** Bounds each case (seconds); a timeout is an isolated per-case error. */
  timeout?: number;
  metadata?: Record<string, unknown> | null;
  select?: (c: EvalCase) => boolean;
  environment?: string;
  /** Explicit transport wins over the default reporting transport. */
  transport?: EvalTransport;
  /**
   * Run in full but report nowhere: the shortcut for `transport: new FakeTransport()`. No
   * credentials, no dataset publish, no run record — a complete EvalRunResult still comes back.
   * Mutually exclusive with `transport`.
   */
  local?: boolean;
  /**
   * Live console progress bar. Undefined = auto (on for an interactive
   * terminal, off when piped/CI); true/false forces it.
   */
  progress?: boolean;
  /** Internal hooks the runner uses to stream per-case events. */
  onCaseStart?: (c: EvalCase) => void;
  onCaseComplete?: (item: EvalItemResult, durationMs: number) => void;
  /** Cooperative cancellation: when aborted, no further cases start and the run finishes
   *  terminally (incomplete) so callers can finalize a partial result (e.g. SIGINT). */
  signal?: AbortSignal;
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

/**
 * `local: true` already answers "where does this run report", so a sink alongside it is a
 * contradiction rather than a precedence question — say so instead of silently picking one.
 */
export const LOCAL_AND_TRANSPORT =
  "pass local: true OR transport, not both — local: true already means 'do not report'.";

const INLINE_DATASET = '<inline>';
const EVAL_ATTR_CONTRACT_VERSION = '1';
const ZERO_TRACE_ID = /^0+$/;

function fmtError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Attach a completion failure to the error the run ALREADY failed with, as secondary context.
 *  The original error keeps propagating unchanged — a failed /complete must never be the error
 *  the user reads first. */
function attachCompletionFailure(bodyError: unknown, completionErr: unknown): void {
  if (typeof bodyError === 'object' && bodyError !== null) {
    (bodyError as { completionError?: unknown }).completionError = completionErr;
  }
}

/** A DatasetSnapshot is a frozen plain object (no class), so it is recognized structurally —
 *  Python gets the same discrimination from `isinstance(data, DatasetSnapshot)`. */
export function isDatasetSnapshot(data: unknown): data is DatasetSnapshot {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    !(data instanceof Dataset) &&
    Array.isArray((data as DatasetSnapshot).cases) &&
    typeof (data as DatasetSnapshot).revision === 'string'
  );
}

function normalizeData(data: Dataset | DatasetSnapshot | EvalCase[]): EvalCase[] {
  const raw = data instanceof Dataset ? [...data] : isDatasetSnapshot(data) ? data.cases : data;
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
    const obj = raw as Record<string, unknown>;
    // Presence of EITHER reserved key means the single-Score shape is intended (both required);
    // an object with neither is a metric->value mapping, one Score per entry.
    if ('name' in obj || 'value' in obj) {
      assertScoreShape(raw);
      return [toScore(raw as Score)];
    }
    const scores: Score[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string') {
        throw new Error(
          `metric-map value for '${k}' must be a scalar (number/boolean/string), got ${typeof v}`,
        );
      }
      scores.push({ name: k, value: v, comment: null, metadata: null });
    }
    return scores;
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

/** A per-case deadline expiry. Distinct type so the scorer loop can tell a budget overrun
 *  (which errors the whole case) apart from an ordinary per-scorer failure (which is isolated). */
class EvalTimeoutError extends Error {}

/** Thrown when a run is cancelled (e.g. SIGINT) so callers can finalize a partial result
 *  instead of a "completed" one. Carries the ids/upload of the run that was actually created and
 *  finalized, so the partial artifact stays associated with its backend run. */
export class CancelledError extends Error {
  localRunId?: string;
  runId?: string | null;
  uploadState?: UploadState;
  /** Set only when finalizing the cancelled run ALSO failed — the cancellation stays the error,
   *  the finalization failure rides along (the run may still be 'running' on the platform). */
  completionError?: unknown;
}

/** Race `p` against the case's shared deadline. `deadline` is an absolute performance.now() ms
 *  mark covering task + scorers together, so a never-resolving scorer can't outlive the budget. */
async function withTimeout<T>(p: Promise<T>, timeout?: number, deadline?: number): Promise<T> {
  if (timeout === undefined) return p;
  const ms = deadline !== undefined ? Math.max(0, deadline - performance.now()) : timeout * 1000;
  let handle: ReturnType<typeof setTimeout>;
  const timer = new Promise<T>((_res, rej) => {
    handle = setTimeout(
      () => rej(new EvalTimeoutError(`TimeoutError: case exceeded ${timeout}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    clearTimeout(handle!);
  }
}

async function runCase(
  evalCase: EvalCase,
  task: TaskFn,
  scorers: ScorerFn[],
  identity: RunIdentity,
  transport: EvalTransport,
  run: RunHandle,
  timeout: number | undefined,
  tracer: Tracer,
  onCaseStart?: (c: EvalCase) => void,
  onCaseComplete?: (item: EvalItemResult, durationMs: number) => void,
  emittedOwnership?: Map<string, Set<string>>,
  droppedResults?: string[],
): Promise<EvalItemResult> {
  onCaseStart?.(evalCase);
  try {
    await transport.registerItem(run, evalCase);
  } catch {
    // reporting is best-effort; a transport blip must not drop the case
  }

  const startedAt = performance.now();
  // Detach from any ambient span (e.g. evaluate() called inside an @observe'd function)
  // so each case is its own independent trace, not a child of the caller's span.
  const root = context.with(ROOT_CONTEXT, () =>
    startSpan({ name: 'evaluation-item', type: 'evaluation', input: evalCase.input }, tracer),
  );
  setRootAttrs(root, identity, evalCase);
  const rawTraceId = root.traceId;
  // A reported run exports its per-case spans, so the result carries the trace id.
  const traceId = !ZERO_TRACE_ID.test(rawTraceId) ? rawTraceId : null;

  let result: EvalItemResult;
  try {
    result = await usingSpan(root, async (): Promise<EvalItemResult> => {
      let output: unknown = null;
      let error: string | null = null;
      const scores: Score[] = [];
      const scorerErrors: Record<string, string> = {};
      // One deadline for the whole case (task + scorers), so a hung scorer cannot outlive it.
      const deadline = timeout !== undefined ? performance.now() + timeout * 1000 : undefined;

      const taskSpan = startSpan(
        {
          name: 'task',
          type: 'task',
          input: evalCase.input,
          attributes: {
            // Canonical classification (matches Python engine): without it the platform ingests
            // this SDK-created span as a generic SPAN with is_evaluation=0. OpenInference span.kind
            // (from `type: 'task'`) and input/output are set separately and stay intact.
            [SpanAttributes.SPAN_TYPE]: 'task',
            [SpanAttributes.EVAL_RUN_NAME]: identity.name,
            [SpanAttributes.EVAL_CASE_ID]: evalCase.id as string,
            [SpanAttributes.EVAL_TASK_NAME]: fnName(task, 'task'),
          },
        },
        tracer,
      );
      try {
        output = await usingSpan(taskSpan, () =>
          withTimeout(Promise.resolve(task(evalCase.input)), timeout, deadline),
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
        try {
          for (const scorer of scorers) {
            // The DECLARED name (same resolver the manifest uses) — the emitted Score, the
            // ownership key and the registered definition must agree or the platform drops the
            // metric's policy.
            const name = scorerName(scorer);
            // Record scorer->metric ownership AT THE POINT OF PRODUCTION (never inferred afterward
            // by matching names). Seed the definition now so a scorer that throws before emitting
            // still appears in the completion manifest with no metrics.
            if (emittedOwnership && !emittedOwnership.has(name))
              emittedOwnership.set(name, new Set());
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
                  // Canonical classification (matches Python engine): without it the platform
                  // ingests this SDK-created span as a generic SPAN with is_evaluation=0. The
                  // OpenInference EVALUATOR kind (from `type: 'scorer'`) and I/O stay intact.
                  [SpanAttributes.SPAN_TYPE]: 'scorer',
                  [SpanAttributes.EVAL_RUN_NAME]: identity.name,
                  [SpanAttributes.EVAL_SCORER_NAME]: name,
                },
              },
              tracer,
            );
            try {
              const raw = await usingSpan(scorerSpan, () =>
                withTimeout(Promise.resolve(scorer(ctx)), timeout, deadline),
              );
              const produced = stampScorerVersion(normalizeScoreLike(raw, name), scorer);
              scores.push(...produced);
              if (emittedOwnership) {
                const set = emittedOwnership.get(name)!;
                for (const s of produced) if (s.name) set.add(s.name);
              }
              recordScorerSpan(scorerSpan, produced);
              if (produced.length > 0) scorerSpan.update({ output: scorerOutputRepr(produced) });
            } catch (err) {
              // A deadline hit is a case-level budget overrun, not an isolated scorer failure:
              // record it on the span and rethrow so the whole case errors (below).
              if (err instanceof EvalTimeoutError) {
                scorerSpan.setError(err);
                scorerSpan.update({
                  output: fmtError(err),
                  attributes: { [SpanAttributes.EVAL_ERROR]: fmtError(err) },
                });
                throw err;
              }
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
        } catch (err) {
          // Scoring exceeded the case deadline -> the same isolated per-case error path as a
          // task timeout (errored case, not scored). Drop any scores collected before the timeout
          // so a timed-out case is truly "not scored" and can't contaminate the summaries/results.
          error = fmtError(err);
          scores.length = 0;
          root.setError(error);
          root.update({ output: error, attributes: { [SpanAttributes.EVAL_ERROR]: error } });
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
  } finally {
    root.end();
  }
  try {
    await transport.recordItemResult(run, result);
    await transport.recordScores(run, result.caseId, result.scores);
  } catch (err) {
    // Reporting is best-effort; the computed result is still returned. But a dropped result must
    // not be invisible — it is counted onto the run's upload state, so a run that completes
    // "uploaded" with missing results can be told apart from a clean one.
    droppedResults?.push(fmtError(err));
  }
  onCaseComplete?.(result, result.durationMs ?? 0);
  return result;
}

/**
 * Publish `data`'s current content as the version this run will pin.
 *
 * Runs BEFORE the first case, so anything it throws aborts the whole evaluation. A raw
 * DatasetConflictError (or a socket timeout) surfaces there as an SDK crash with no hint of what
 * to do, so the failure is restated as what actually happened plus the ways out.
 */
async function autoPublish(data: Dataset): Promise<void> {
  try {
    // Route through push() rather than pushDataset() directly: push() also advances
    // baseVersionId, the optimistic-concurrency base for the NEXT push. Assigning only
    // datasetVersionId leaves the base null, so a later explicit push() sends
    // base_version_id: null against a dataset that now has a version — a spurious 409. The base
    // is whatever version this dataset is standing on: its push base, or the version it was
    // pulled at (a pull pins datasetVersionId only).
    //
    // Auto-approve the new version instead of falling through to the interactive confirmation: a
    // versioning decision must never block a run waiting on [y/N]. The run's content is
    // authoritative — publishing it is what lets the run pin exactly what it scored. The
    // explicit, user-initiated Dataset.push() keeps the prompt; that is where deliberate version
    // management lives.
    await data.push(new PlatformDatasetSync(), data.baseVersionId ?? data.datasetVersionId, {
      onExisting: () => true,
    });
    // What is now pinned is exactly what was published, so the NEXT run can tell a mutation from
    // an untouched dataset without another round trip.
    rememberPinnedContent(data);
  } catch (err) {
    throw new Error(
      `could not auto-publish dataset '${data.name}' before the run: ${fmtError(err)}. ` +
        'Pull the latest version and retry (pullDataset(...)), or pass a dataset that is ' +
        'already synced, or pass transport / local: true to run without publishing.',
    );
  }
}

/**
 * Build the reporting transport from credentials + a synced dataset (pulled/pushed, or an
 * explicit datasetId). Returns null when it cannot (no credentials, or an unsynced dataset the
 * SDK cannot create server-side); the caller turns that into a clear error (cloud-only).
 */
function autoTransport(
  data: Dataset | DatasetSnapshot | EvalCase[],
  datasetId: string | undefined,
  scorers: ScorerFn[],
  candidateVersion: string | undefined,
  environment: string | undefined,
): EvalTransport | null {
  let effectiveId = datasetId;
  let versionId: string | null = null;
  if (data instanceof Dataset) {
    versionId = data.datasetVersionId ?? null;
    if (effectiveId === undefined && data.datasetId && versionId !== null)
      effectiveId = data.datasetId;
  } else if (isDatasetSnapshot(data)) {
    // A snapshot taken from a synced dataset carries baseVersionId; treat it like a synced
    // Dataset so `evaluate(dataset.snapshot())` reports instead of failing "no synced dataset".
    versionId = data.baseVersionId;
    if (effectiveId === undefined && data.datasetId && versionId !== null)
      effectiveId = data.datasetId;
  }
  if (!effectiveId) return null;
  const { apiKey } = TraceRoot.resolveCredentials();
  if (!apiKey) return null;
  return new PlatformTransport(effectiveId, {
    scorerNames: scorers.map((s) => scorerName(s)),
    candidateVersion: candidateVersion ?? null,
    environment,
    datasetVersionId: versionId,
  });
}

/** Run an evaluation. Async-first; `evaluate` is an alias of `evaluateAsync`. */
export async function evaluateAsync(options: EvaluateOptions): Promise<EvalRunResult> {
  const { name, task, scorers, maxConcurrency = 10, transport, candidateVersion } = options;
  const local = options.local === true;
  const environment = options.environment ?? 'evaluation';
  const data = options.dataset ?? options.data;

  if (local && transport !== undefined) throw new Error(LOCAL_AND_TRANSPORT);
  if (!name || name.trim().length === 0) throw new Error("evaluate() requires a non-empty 'name'");
  if (data === undefined) throw new Error("evaluate() requires 'dataset' (or the 'data' alias)");
  if (typeof task !== 'function') throw new Error("'task' must be a function");
  if (!scorers || scorers.length === 0) throw new Error('evaluate() requires at least one scorer');
  for (const s of scorers) {
    if (typeof s !== 'function') throw new Error(`scorer ${String(s)} is not a function`);
    // A TS scorer is called as scorer(ctx). A Python-style positional (input, output) signature
    // would bind input=ScorerContext, output=undefined and score every case wrong with no error,
    // so reject it here instead of at read time. A destructured ({input, output}) arrow declares
    // one parameter and passes; two-or-more declared parameters cannot be the context form.
    if (s.length >= 2) {
      throw new Error(
        `scorer ${scorerName(s)} takes a single ScorerContext — destructure it: ` +
          '({ input, output, expected, metadata }) => ...',
      );
    }
  }
  // A Score row's identity IS its emitted-metric name, and the platform keys that metric's
  // direction/threshold on the name. Two scorers resolving to the same name make the policy
  // ambiguous, so the platform drops the metric to non-directional. Catch the static case here,
  // before a single case runs.
  const seen = new Map<string, number>();
  for (const s of scorers) {
    const n = scorerName(s);
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const duplicated = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([n]) => n)
    .sort();
  if (duplicated.length > 0) {
    const listed = duplicated.map((n) => `'${n}'`).join(', ');
    throw new Error(
      `two or more scorers report the same metric name (${listed}); metric names must be ` +
        'unique within a run. Give each scorer a distinct name (or key).',
    );
  }
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    // Guard NaN / fractional / non-finite too: runBounded would otherwise launch zero workers and
    // silently leave every case unprocessed.
    throw new Error("'maxConcurrency' must be a positive integer");
  }

  let cases = normalizeData(data);
  if (options.select) cases = cases.filter(options.select);
  if (cases.length === 0) throw new Error('evaluate() requires at least one case to run');

  // A snapshot already IS the immutable description of what ran, so its own name/revision are
  // reported verbatim rather than re-derived (Python: _to_snapshot returns `data` unchanged).
  const snapshot = isDatasetSnapshot(data) ? data : null;
  const datasetName = data instanceof Dataset ? data.name : (snapshot?.name ?? INLINE_DATASET);
  const snapshotRevision =
    data instanceof Dataset
      ? data.snapshot().revision
      : (snapshot?.revision ?? `local-${cases.length}`);
  // A run is not identified by which SDK produced it, so no SDK-language identity is reported.
  // But git/CI provenance (commit/branch/dirty, CI build) is NON-IDENTITY reproducibility
  // metadata — it rides the wire as free-form run metadata (user keys win on conflict), so the
  // platform can tie a run to the exact commit + dataset version. Same combined view backs the
  // local artifact.
  const runMetadata = collectRunProvenance(options.metadata, { detectDirty: false });

  // Cloud-only by default: an explicit transport wins; otherwise build a reporting transport
  // from credentials + a synced dataset.
  let active: EvalTransport;
  if (local) {
    // local: true IS transport: new FakeTransport(), spelled as intent rather than as a class the
    // user has to import: the run executes in full and records itself in memory, but nothing
    // leaves the process. Selected ahead of the auto path so it also short-circuits the
    // auto-publish below — a local run needs no credentials and versions no dataset, even one
    // that is already synced.
    active = new FakeTransport();
  } else if (transport !== undefined) {
    active = transport;
  } else {
    // Auto-provision a locally-authored, unsynced Dataset: publish it once so the run has a
    // server-side version to attach to -- the user never writes a manual "sync then run" step.
    // Idempotent: unchanged content reuses the
    // current version. Only for a local Dataset with credentials; an explicit datasetId or an
    // explicit transport skip this.
    //
    // A dataset that IS pinned republishes only once it has drifted from the version it is pinned
    // to. A Dataset is mutable and evaluate() is re-runnable, so pinning the version from a
    // previous run (or from the pull) would attribute the cases this run actually scored to
    // content that never contained them.
    if (data instanceof Dataset && options.datasetId === undefined) {
      const { apiKey } = TraceRoot.resolveCredentials();
      if (apiKey && (data.datasetVersionId === undefined || pinnedContentChanged(data))) {
        await autoPublish(data);
      }
    }
    const auto = autoTransport(data, options.datasetId, scorers, candidateVersion, environment);
    if (auto === null) {
      // autoTransport returns null for two unrelated reasons; saying "no credentials" for both
      // misdirects a user who HAS a key but passed inline cases or an unsynced dataset.
      if (TraceRoot.resolveCredentials().apiKey) {
        throw new Error(
          'evaluate() reports to the TraceRoot platform, but this run has no synced dataset to ' +
            'report against. Pass a Dataset that was pulled or pushed (pullDataset(...) / ' +
            'Dataset.push(...)), or pass datasetId, or pass local: true to run without ' +
            'reporting.',
        );
      }
      throw new Error(
        'evaluate() reports to the TraceRoot platform, but no credentials were found. Set ' +
          'TRACEROOT_API_KEY (initialize traceroot or set the env var), or pass local: true to ' +
          'run without reporting.',
      );
    }
    // A reported run records every score with a per-metric `passed`; no overall run-level pass/fail
    // is invented (there is no headline metric).
    active = auto;
  }

  // Forward scorer comparison metadata to a transport that accepts specs (before createRun).
  const specs = describeScorers(scorers);
  if ('scorerSpecs' in active && (active as PlatformTransport).scorerSpecs === undefined) {
    (active as PlatformTransport).scorerSpecs = specs;
  }
  // Same seam for the evaluation's stable identity: fill it only when the transport has the field
  // and nothing has set it, so a transport constructed with an explicit key keeps it.
  if (
    options.evaluationKey !== undefined &&
    'evaluationKey' in active &&
    (active as PlatformTransport).evaluationKey == null
  ) {
    (active as PlatformTransport).evaluationKey = options.evaluationKey;
  }

  // A reported run's structural spans export and are linked to its results. A local run gets a
  // non-exporting tracer: the span tree carries the case input and the task output as span I/O, so
  // exporting it would send off-process exactly the payloads `local: true` promises to keep in.
  const evalSpanTracer = evalTracer(local);
  const localRunId = newRunId();
  const run = await active.createRun(name, datasetName, runMetadata ?? null, localRunId);

  const identity: RunIdentity = {
    name,
    datasetName,
    datasetId:
      options.datasetId ??
      (data instanceof Dataset ? data.datasetId : (snapshot?.datasetId ?? 'ds_inline')),
    datasetVersionId:
      data instanceof Dataset ? (data.datasetVersionId ?? null) : (snapshot?.baseVersionId ?? null),
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

  let itemResults: EvalItemResult[] = [];
  // Definitely assigned before any use: the finally below either assigns it or throws.
  let uploadState!: UploadState;
  let cancelled = false;
  // definition name -> the metric names it emitted, accumulated across cases (union: a metric
  // emitted by only some cases still counts). Recorded during execution, sent at completion.
  const emittedOwnership = new Map<string, Set<string>>();
  // Per-case result POSTs the transport dropped (best-effort reporting), surfaced on the upload
  // state so a green run with silently-missing results is detectable.
  const droppedResults: string[] = [];
  let bodyFailed = false;
  let bodyError: unknown;
  // A finalization failure on a CANCELLED run: kept, not thrown, so the cancellation survives.
  let cancelCompletionError: unknown;
  // While a local run executes, keep everything in-process by suppressing tracing on the
  // OTel context that its cases run under (see the context.with(suppressTracing(...)) wrapper
  // below). OTel-JS honours suppression inside Tracer.startSpan, so any application span (user
  // observe/startSpan, provider auto-instrumentation, a default-dispatch judge) started under
  // that context is non-recording and never reaches the exporter — even from a provider the app
  // already initialized. This is origin-scoped, not process-global: a concurrent reported run on
  // a different context is unaffected, and a span that escapes the run's context still exports.
  // The lazy-init guard below is still needed for the case where no provider exists yet: a
  // suppressed context does not stop startSpan()/observe() from BOOTING the exporting provider,
  // so keep stopping that. Released in the finally (balanced, nestable via the depth counter). A
  // reported run wants the global provider, so it is not suppressed.
  if (local) {
    _pushSuppressGlobalAutoInit();
  }
  const runCases = () =>
    runBounded<EvalItemResult | null>(cases.length, maxConcurrency, (i) => {
      // Cooperative cancellation: once aborted, workers stop pulling NEW cases (return a skip),
      // but already-running cases are still awaited by runBounded — so every case that began
      // finishes recording before we finish the run below (no lost in-flight results).
      if (options.signal?.aborted) {
        cancelled = true;
        return Promise.resolve(null);
      }
      return runCase(
        cases[i],
        task,
        scorers,
        identity,
        active,
        run,
        options.timeout,
        evalSpanTracer,
        options.onCaseStart,
        onCaseComplete,
        emittedOwnership,
        droppedResults,
      );
    });
  try {
    // Scope suppression to exactly the case-execution phase of a local run: spans created under
    // this context (and their auto-instrumented descendants) are non-recording, so they never
    // forward to the exporter — including late spans whose .end() fires after the run returns.
    const raw = local
      ? await context.with(suppressTracing(context.active()), runCases)
      : await runCases();
    itemResults = raw.filter((r): r is EvalItemResult => r !== null);
    // If every case was already in flight when the abort arrived, no worker pulled a new case, so
    // the flag above never flipped — re-check the signal after runBounded settles so an
    // in-flight-only cancellation still finalizes as incomplete and raises CancelledError.
    if (options.signal?.aborted) cancelled = true;
  } catch (err) {
    bodyFailed = true; // remembered, then re-thrown untouched
    bodyError = err;
    throw err;
  } finally {
    if (local) {
      _popSuppressGlobalAutoInit();
    }
    reporter?.finish();
    // Finish the run inside finally so a mid-run failure never leaves it open on the backend.
    // A cancelled run closes 'incomplete', so a registered run is never left orphaned in 'running'.
    // Runs AFTER all in-flight cases above have settled. Completion is the LAST thing to run, so
    // it must never become the story: if the run already failed, the original error keeps
    // propagating and the completion failure rides along on it (it used to REPLACE the real
    // cause — a /complete 400 buried the actual exception).
    // A run whose body did not get through its cases is INCOMPLETE, whatever stopped it — an
    // abort, or anything that threw out of the case loop. Left to derive its own status the
    // transport would report 'completed' for an evaluation that scored two cases out of five. An
    // errored CASE is not an unfinished run: that path leaves the status null so the error counts
    // decide.
    const status = cancelled || bodyFailed ? 'incomplete' : null;
    const emitted: Record<string, string[]> = {};
    for (const [def, metrics] of emittedOwnership) emitted[def] = [...metrics].sort();
    try {
      uploadState = {
        ...(await active.finishRun(run, status, emitted)),
        failedResultCount: droppedResults.length,
      };
    } catch (completionErr) {
      if (bodyFailed) {
        attachCompletionFailure(bodyError, completionErr);
      } else if (cancelled) {
        // Cancellation is the caller's story (Ctrl-C is not a backend fault) and it is what this
        // path documents raising. An EvalCompletionError thrown here would REPLACE that identity,
        // leaving an aborted run indistinguishable from a broken backend — so remember the
        // failure and let the CancelledError below carry it as secondary context.
        cancelCompletionError = completionErr;
      } else {
        // The run itself succeeded: one clear error naming the completion failure, with the
        // transport error carried as data rather than chained into a cause chain.
        // Reached only in this else branch (body succeeded, nothing propagating), so this throw
        // overrides no in-flight exception.
        // eslint-disable-next-line no-unsafe-finally
        throw new EvalCompletionError(
          'the evaluation ran but the run could not be finalized on the platform: ' +
            `${fmtError(completionErr)}. The run stays 'running' until a retry completes it.`,
          completionErr,
        );
      }
    }
  }
  if (cancelled) {
    // Surface the run's real identity + upload so the caller's partial artifact stays associated
    // with the backend run that was created and finalized.
    const err = new CancelledError('evaluation cancelled');
    err.localRunId = localRunId;
    err.runId = active.runId ?? null;
    err.uploadState = uploadState;
    // Undefined unless finalization ALSO failed (uploadState is then unset): the run may still be
    // 'running' on the platform, and that is worth handing back with the cancellation.
    if (cancelCompletionError !== undefined) err.completionError = cancelCompletionError;
    throw err;
  }

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
    // Retain the declared scorer policy so an explicit result.upload() can re-declare each metric's
    // threshold/direction rather than re-register policy-less. Captured from the scorers directly
    // (`specs` above), not the transport, so a local/Fake run — "run now, upload later" — keeps it.
    scorerSpecs: specs,
    // Retain the scorer -> emitted-metric ownership so an explicit result.upload() re-declares it on
    // finishRun (the same manifest this run sent). Built from the run's ownership map; {} when empty.
    emittedMetrics: Object.fromEntries(
      [...emittedOwnership].map(([def, metrics]) => [def, [...metrics].sort()]),
    ),
  });

  // When the bar was shown (interactive), print the run's summary too — so calling evaluate() on a
  // terminal SHOWS its result (metric means + counts) without the caller writing
  // console.log(run.summary()). Gated on the reporter, so piped/CI/programmatic callers keep clean
  // stdout and read result.summary() / result.uploadState themselves.
  if (reporter) {
    console.log(result.summary());
  }

  // When the bar was shown (interactive), surface the clickable run link if the backend
  // returned one. Off-terminal callers read result.uploadState instead. (Candidate-vs-
  // baseline comparison is the backend's job, not the SDK's.)
  if (reporter && uploadState.dashboardUrl) {
    printRunUrl(uploadState.dashboardUrl);
  }

  return result;
}

/** Alias of {@link evaluateAsync}. TypeScript has no blocking mode; both return a Promise. */
export const evaluate = evaluateAsync;
