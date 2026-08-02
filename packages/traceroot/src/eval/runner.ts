// src/eval/runner.ts — stable runner entry point for the CLI (parity with
// traceroot-py/traceroot/eval/runner.py).
//
// Invoked out-of-process as: node <dist>/eval/runner.js <eval files...> (or via tsx).
// It imports each eval module, inspects module-level Evaluation instances (no registry),
// runs them via the installed SDK, and streams NDJSON events on fd 3
// (TRACEROOT_EVAL_EVENT_FD) or a file (TRACEROOT_EVAL_EVENT_FILE). Options come from the
// JSON env var TRACEROOT_EVAL_OPTIONS; eval files come from argv. The runner ALWAYS exits 0
// when the harness functioned (pass/fail is in the events); it emits `fatal` before dying,
// and exits 130 on SIGINT after finalizing a partial artifact.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SDK_VERSION } from '../processor';
import { Evaluation } from './evaluation';
import { newRunId } from './ids';
import { Dataset, EvalCase, Score } from './types';
import { EvalItemResult, EvalRunResult, RunDatasetRef, caseStatus, makeRunResult } from './results';
import { CancelledError } from './engine';

export const EVAL_API_VERSION = 1;
export function capabilities(): Record<string, boolean> {
  return {
    snapshot: true,
    run_session: true,
    compare: true,
    dataset_push: true,
    sampling: true,
    provenance: true,
    cancellation: true,
  };
}

const DEFAULT_RUN_DIR = '.traceroot/eval/runs';

type EventSink = (line: string) => void;
type RunnerOptions = Record<string, any>;

// --- event emitter (NDJSON) --------------------------------------------------
export class Emitter {
  constructor(private readonly write: EventSink) {}
  emit(event: Record<string, unknown>): void {
    this.write(JSON.stringify(event) + '\n');
  }
}

function openChannel(): EventSink {
  const eventFile = process.env['TRACEROOT_EVAL_EVENT_FILE'];
  if (eventFile) {
    const fd = openSync(eventFile, 'a');
    return (line) => writeSync(fd, line);
  }
  const fdRaw = process.env['TRACEROOT_EVAL_EVENT_FD'];
  if (fdRaw && /^\d+$/.test(fdRaw)) {
    const fd = Number(fdRaw);
    return (line) => writeSync(fd, line);
  }
  return (line) => writeSync(1, line);
}

function loadOptions(): RunnerOptions {
  const raw = process.env['TRACEROOT_EVAL_OPTIONS'];
  return raw ? JSON.parse(raw) : {};
}

/** Guarantee no TraceRoot data leaves this process in local-only mode. */
function enforceLocalOnly(): void {
  process.env['TRACEROOT_ENABLED'] = 'false';
}

// --- discovery (module inspection, no registry) ------------------------------
function iterPaths(paths: string[]): string[] {
  const files: string[] = [];
  for (const raw of paths) {
    const p = resolve(raw);
    if (existsSync(p) && statSync(p).isDirectory()) {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.startsWith('_'))
            files.push(full);
        }
      };
      walk(p);
    } else {
      files.push(p);
    }
  }
  return files;
}

export async function discover(paths: string[]): Promise<Array<[string, Evaluation]>> {
  const found: Array<[string, Evaluation]> = [];
  const seen = new Set<Evaluation>();
  for (const path of iterPaths(paths)) {
    const mod = await import(pathToFileURL(path).href);
    for (const value of Object.values(mod)) {
      if (value instanceof Evaluation && !seen.has(value)) {
        seen.add(value);
        found.push([path, value]);
      }
    }
  }
  return found;
}

// --- sampling / filtering ----------------------------------------------------
function caseIds(data: Dataset | EvalCase[]): string[] {
  if (data instanceof Dataset) return [...data].map((c) => c.id as string);
  return data.map((item, i) => (item.id ?? `case-${i}`) as string);
}

function subset(
  data: Dataset | EvalCase[],
  first: number | undefined,
  sample: number | undefined,
  seed: number,
): [Set<string> | null, string, boolean] {
  if (first === undefined && sample === undefined) return [null, 'full', true];
  const ids = caseIds(data);
  if (first !== undefined) return [new Set(ids.slice(0, first)), 'first', false];
  const n = sample !== undefined ? Math.min(sample, ids.length) : ids.length;
  // Deterministic positional sample (seeded LCG) — reproducible across imports.
  let s = seed >>> 0 || 1;
  const rand = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const positions = ids.map((_, i) => i);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  return [new Set(positions.slice(0, n).map((i) => ids[i])), 'sample', false];
}

function nowIso(): string {
  return new Date().toISOString();
}

function datasetIdentity(data: Dataset | EvalCase[]): {
  dataset_id: string | null;
  dataset_version_id: string | null;
  name: string | null;
} {
  const d = data as any;
  return {
    dataset_id: d?.datasetId ?? null,
    dataset_version_id: d?.datasetVersionId ?? d?.baseVersionId ?? null,
    name: d?.name ?? null,
  };
}

// --- event / artifact shaping ------------------------------------------------
function scorePassed(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value >= 1.0;
  return null;
}

function scoreEvent(s: Score): Record<string, unknown> {
  return {
    scorer_name: s.name,
    scorer_version: s.version ?? null,
    value: s.value,
    passed: scorePassed(s.value),
    explanation: s.comment ?? null,
  };
}

function scorerErrorEvents(item: EvalItemResult): Record<string, unknown>[] {
  return Object.entries(item.scorerErrors).map(([name, msg]) => ({
    scorer_name: name,
    scorer_version: null,
    message: msg,
  }));
}

function scorerVersions(result: EvalRunResult): Record<string, string | null> {
  const versions: Record<string, string | null> = {};
  for (const item of result.itemResults) {
    for (const s of item.scores) {
      if (!(s.name in versions)) versions[s.name] = s.version ?? null;
      if (s.version != null) versions[s.name] = s.version;
    }
  }
  return versions;
}

function caseMetadata(item: EvalItemResult): Record<string, unknown> {
  return {
    case_id: item.caseId,
    status: caseStatus(item),
    scores: item.scores.map(scoreEvent),
    task_error: item.error,
    scorer_errors: scorerErrorEvents(item),
    trace_id: item.traceId,
    duration_ms: item.durationMs,
  };
}

function runStatus(result: EvalRunResult, cancelled: boolean): string {
  if (cancelled) return 'incomplete';
  if (result.taskErrorCount || result.scorerErrorCount) return 'completed_with_errors';
  return 'completed';
}

function counts(result: EvalRunResult): Record<string, number> {
  return {
    cases: result.caseCount,
    scored: result.scoredCount,
    passed: result.passed,
    failed: result.failed,
    task_errors: result.taskErrorCount,
    scorer_errors: result.scorerErrorCount,
    not_scored: result.notScored,
  };
}

function ensureGitignore(dir: string): void {
  // Drop a '*' .gitignore so local eval payloads (which may hold PII/secrets in case
  // input/output) can't be accidentally committed. Never clobbers a user's file.
  const gi = join(dir, '.gitignore');
  if (existsSync(gi)) return;
  try {
    writeFileSync(
      gi,
      '# TraceRoot local evaluation artifacts -- may contain payloads. Do not commit.\n*\n',
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

function atomicWrite(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Parity with Python `_atomic_write`: restrict the artifact dir so payload files are
  // not world-readable/listable (best-effort; a no-op on platforms without POSIX modes).
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  ensureGitignore(dir);
  const tmp = path + '.tmp';
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface WriteArtifactsOptions {
  status: string;
  runMode: string;
  isFinal: boolean;
  sampleCount: number | null;
  sampleSeed: number | null;
  candidateVersion: string | null;
  provenance: Record<string, unknown> | null;
  createdAt?: string;
  /** Opt-in per-payload byte cap (parity with Python `max_payload_bytes`). */
  maxPayloadBytes?: number | null;
}

/**
 * Bound one payload to `limit` bytes (parity with Python `_truncate`). Over-limit values
 * become an explicit `{ truncated, preview }` marker so a consumer never mistakes a cap
 * for real data. `null`/undefined limit = no truncation (current default).
 */
function truncatePayload(value: unknown, limit: number | null | undefined): [unknown, boolean] {
  if (limit == null) return [value, false];
  const text = JSON.stringify(value ?? null) ?? 'null';
  if (Buffer.byteLength(text, 'utf8') <= limit) return [value, false];
  return [{ truncated: true, preview: text.slice(0, limit) }, true];
}

export function writeArtifacts(
  result: EvalRunResult,
  runPath: string,
  casesPath: string,
  o: WriteArtifactsOptions,
): Record<string, unknown> {
  let truncatedAny = false;
  const caseLines: string[] = result.itemResults.map((item) => {
    const [input, t1] = truncatePayload(item.input, o.maxPayloadBytes);
    const [output, t2] = truncatePayload(item.output, o.maxPayloadBytes);
    const [expected, t3] = truncatePayload(item.expected, o.maxPayloadBytes);
    truncatedAny = truncatedAny || t1 || t2 || t3;
    return JSON.stringify({
      schema_version: '1',
      case_id: item.caseId,
      status: caseStatus(item),
      input,
      output,
      expected,
      scores: item.scores.map(scoreEvent),
      scorer_errors: scorerErrorEvents(item),
      task_error: item.error,
      trace_id: item.traceId,
      duration_ms: item.durationMs,
    });
  });
  atomicWrite(casesPath, caseLines.join('\n') + (caseLines.length ? '\n' : ''));

  const artifact = {
    run: runPath,
    cases: casesPath,
    payloads: truncatedAny ? 'truncated' : 'complete',
  };
  const versions = scorerVersions(result);
  const runDoc: Record<string, unknown> = {
    schema_version: '1',
    kind: 'eval_run',
    local_run_id: result.localRunId,
    run_id: result.runId,
    created_at: o.createdAt ?? nowIso(),
    evaluation_name: result.name,
    status: o.status,
    candidate_version: o.candidateVersion,
    run_mode: o.runMode,
    is_final: o.isFinal,
    sample: { count: o.sampleCount, seed: o.sampleSeed },
    provenance: o.provenance,
    dataset: result.dataset
      ? {
          dataset_id: result.dataset.datasetId,
          revision: result.dataset.revision,
          dataset_version_id: result.dataset.datasetVersionId,
          case_count: result.dataset.caseCount,
        }
      : null,
    scorers: Object.keys(result.scoreSummary).map((n) => ({
      name: n,
      version: versions[n] ?? null,
    })),
    counts: counts(result),
    scores: Object.fromEntries(Object.entries(result.scoreSummary).map(([k, v]) => [k, { ...v }])),
    upload: { status: result.uploadState.status, dashboard_url: result.uploadState.dashboardUrl },
    artifact,
    cases: result.itemResults.map(caseMetadata),
  };
  atomicWrite(runPath, JSON.stringify(runDoc, null, 2));
  return artifact;
}

// --- suite execution ---------------------------------------------------------
export async function runSuite(
  paths: string[],
  options: RunnerOptions,
  emitter: Emitter,
  signal?: AbortSignal,
): Promise<boolean> {
  const reporting = Boolean(options.reporting);
  if (!reporting) enforceLocalOnly();

  emitter.emit({
    type: 'hello',
    sdk_version: SDK_VERSION,
    eval_api_version: EVAL_API_VERSION,
    capabilities: capabilities(),
  });

  let discovered: Array<[string, Evaluation]>;
  try {
    discovered = await discover(paths);
  } catch (exc) {
    emitter.emit({ type: 'fatal', kind: 'import_error', message: fmt(exc) });
    return false;
  }

  const filters: string[] = options.filter ?? [];
  if (filters.length) {
    const wanted = new Set(filters);
    discovered = discovered.filter(([, e]) => wanted.has(e.name));
  }

  if (options.mode === 'list') {
    emitter.emit({
      type: 'definitions',
      evaluations: discovered.map(([m, e]) => ({ name: e.name, module: m })),
    });
    return false;
  }

  let completed = 0;
  let cancelled = false;
  for (const [, evaluation] of discovered) {
    try {
      await runOne(evaluation, options, reporting, emitter, signal);
      completed += 1;
    } catch (err) {
      if (err instanceof CancelledError) {
        completed += 1;
        cancelled = true;
        break;
      }
      throw err;
    }
  }
  emitter.emit({ type: 'suite_completed', evaluations: completed, cancelled });
  return cancelled;
}

async function runOne(
  evaluation: Evaluation,
  options: RunnerOptions,
  reporting: boolean,
  emitter: Emitter,
  signal?: AbortSignal,
): Promise<void> {
  const first = options.first;
  const sample = options.sample;
  const seed = Number(options.sample_seed ?? 0) || 0;
  const candidateVersion = options.candidate_version ?? evaluation.candidateVersion ?? null;
  const provenance = options.provenance ?? null;
  const createdAt = nowIso();
  const identity = datasetIdentity(evaluation.dataset as Dataset | EvalCase[]);

  const [chosen, runMode, isFinalInitial] = subset(
    evaluation.dataset as Dataset | EvalCase[],
    first,
    sample,
    seed,
  );
  let isFinal = isFinalInitial;
  const baseSelect = evaluation.select;
  const select =
    chosen !== null
      ? (c: EvalCase) => (baseSelect ? baseSelect(c) : true) && chosen.has(c.id as string)
      : baseSelect;

  const fullCount = caseIds(evaluation.dataset as Dataset | EvalCase[]).length;
  const caseCount = chosen !== null ? chosen.size : fullCount;
  emitter.emit({
    type: 'evaluation_started',
    name: evaluation.name,
    created_at: createdAt,
    candidate_version: candidateVersion,
    run_mode: runMode,
    is_final: isFinal,
    dataset: {
      case_count: caseCount,
      dataset_id: identity.dataset_id,
      dataset_version_id: identity.dataset_version_id,
      name: identity.name,
    },
  });

  const collected: EvalItemResult[] = [];
  const onCaseStart = (c: EvalCase): void => emitter.emit({ type: 'case_started', case_id: c.id });
  const onCaseComplete = (item: EvalItemResult): void => {
    collected.push(item);
    emitter.emit({ type: 'case_completed', ...caseMetadata(item) });
  };

  const overrides: Record<string, unknown> = {
    candidateVersion: candidateVersion ?? undefined,
    select,
    local: !reporting,
    // The runner speaks NDJSON on its own channel; never draw a progress bar.
    progress: false,
    onCaseStart,
    onCaseComplete,
    signal,
  };
  if (options.max_concurrency) overrides.maxConcurrency = Number(options.max_concurrency);
  if (options.timeout != null) overrides.timeout = options.timeout;

  let cancelled = false;
  let result: EvalRunResult;
  try {
    result = await evaluation.run(overrides);
  } catch (err) {
    if ((err as Error)?.name === 'SIGINT' || err instanceof CancelledError) {
      cancelled = true;
      isFinal = false;
      result = partialResult(evaluation, collected, candidateVersion);
    } else {
      throw err;
    }
  }

  const status = runStatus(result, cancelled);
  let artifact: Record<string, unknown> | null = null;
  if (!options.no_artifact) {
    const [runPath, casesPath] = artifactPaths(options, result.localRunId);
    artifact = writeArtifacts(result, runPath, casesPath, {
      status,
      runMode,
      isFinal,
      sampleCount: chosen !== null ? chosen.size : null,
      sampleSeed: chosen !== null ? seed : null,
      candidateVersion,
      provenance,
      createdAt,
      maxPayloadBytes: options.max_payload_bytes != null ? Number(options.max_payload_bytes) : null,
    });
  }

  emitter.emit({
    type: 'evaluation_completed',
    name: evaluation.name,
    status,
    created_at: createdAt,
    local_run_id: result.localRunId,
    run_id: result.runId,
    dataset: {
      dataset_id: result.dataset?.datasetId ?? null,
      dataset_version_id: result.dataset?.datasetVersionId ?? null,
    },
    counts: counts(result),
    score_summary: Object.fromEntries(
      Object.entries(result.scoreSummary).map(([k, v]) => [k, { ...v }]),
    ),
    artifact,
  });
  if (cancelled) throw new CancelledError();
}

function partialResult(
  evaluation: Evaluation,
  collected: EvalItemResult[],
  candidateVersion: string | null,
): EvalRunResult {
  const data = evaluation.dataset;
  let datasetId = 'ds_inline';
  let revision = 'rev_partial';
  let versionId: string | null = null;
  if (data instanceof Dataset) {
    const snap = data.snapshot();
    datasetId = snap.datasetId;
    revision = snap.revision;
    versionId = data.datasetVersionId ?? null;
  }
  const dataset: RunDatasetRef = {
    datasetId,
    revision,
    datasetVersionId: versionId,
    caseCount: collected.length,
  };
  return makeRunResult(
    evaluation.name,
    collected,
    { status: 'uploaded', dashboardUrl: null },
    {
      localRunId: newRunId(),
      candidateVersion,
      dataset,
      runScores: [],
    },
  );
}

function artifactPaths(options: RunnerOptions, localRunId: string): [string, string] {
  if (options.out_run && options.out_cases) return [options.out_run, options.out_cases];
  const outDir = options.out_dir ?? DEFAULT_RUN_DIR;
  return [join(outDir, `${localRunId}.json`), join(outDir, `${localRunId}.cases.jsonl`)];
}

function fmt(exc: unknown): string {
  return exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
}

export async function main(argv?: string[]): Promise<number> {
  const paths = argv ?? process.argv.slice(2);
  const emitter = new Emitter(openChannel());
  const options = loadOptions();

  let sigint = false;
  // Abort the active run on Ctrl+C so it stops promptly and finalizes a partial artifact,
  // instead of running every remaining case and reporting a misleading "completed".
  const controller = new AbortController();
  process.on('SIGINT', () => {
    sigint = true;
    controller.abort();
  });

  try {
    const cancelled = await runSuite(paths, options, emitter, controller.signal);
    if (cancelled || sigint) return 130;
  } catch (exc) {
    emitter.emit({ type: 'fatal', kind: 'harness_error', message: fmt(exc) });
  }
  return 0;
}

// Detect direct execution (node dist/eval/runner.js ...). CommonJS build.
declare const require: NodeJS.Require | undefined;
declare const module: NodeJS.Module | undefined;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main().then((code) => process.exit(code));
}
