// src/eval/session.ts — low-level evaluation run lifecycle (parity with
// traceroot-py/traceroot/eval/session.py).
//
// A RunSession is the explicit, retry-safe lifecycle for distributed/async/custom harnesses:
// start a run, pre-register cases, record results, attach traces/scores out of order, then
// complete/fail/cancel. Built on the EvalTransport seam; the high-level runner uses it too.

import { randomUUID } from 'node:crypto';

import type { EvalCase, Score } from './types';
import type { EvalItemResult, UploadState } from './results';
import type { EvalTransport, RunHandle } from './transport';

export interface RunSessionOptions {
  name: string;
  datasetName?: string;
  datasetRef?: unknown;
  candidateVersion?: string | null;
  environment?: string;
  clientRunId?: string | null;
  metadata?: Record<string, unknown> | null;
}

function emptyItem(caseId: string): EvalItemResult {
  return {
    caseId,
    input: null,
    output: null,
    expected: null,
    scores: [],
    scorerErrors: {},
    error: null,
    traceId: null,
    durationMs: null,
  };
}

export class RunSession {
  readonly name: string;
  readonly datasetName: string;
  readonly datasetRef: unknown;
  readonly candidateVersion: string | null;
  readonly environment: string;
  readonly clientRunId: string;
  readonly metadata: Record<string, unknown> | null;

  private run: RunHandle | null = null;
  private readonly items = new Map<string, EvalItemResult>();

  constructor(
    readonly transport: EvalTransport,
    opts: RunSessionOptions,
  ) {
    this.name = opts.name;
    this.datasetName = opts.datasetName ?? '<inline>';
    this.datasetRef = opts.datasetRef ?? null;
    this.candidateVersion = opts.candidateVersion ?? null;
    this.environment = opts.environment ?? 'evaluation';
    // Stable idempotency key so retried start() calls resolve to the same run.
    this.clientRunId = opts.clientRunId ?? `crun_${randomUUID().replace(/-/g, '')}`;
    this.metadata = opts.metadata ?? null;
  }

  // --- lifecycle ---
  async start(): Promise<RunSession> {
    this.run = await this.transport.createRun(
      this.name,
      this.datasetName,
      this.metadata,
      this.clientRunId,
    );
    return this;
  }

  private requireRun(): RunHandle {
    if (this.run === null) throw new Error('RunSession.start() must be called before recording');
    return this.run;
  }

  /** Pre-register a case before its output exists. */
  async register(evalCase: EvalCase): Promise<void> {
    const run = this.requireRun();
    this.items.set(evalCase.id as string, {
      ...emptyItem(evalCase.id as string),
      input: evalCase.input,
      expected: evalCase.expected ?? null,
    });
    await this.transport.registerItem(run, evalCase);
  }

  /** Record (upsert) a full item result and its scores. */
  async record(itemResult: EvalItemResult): Promise<void> {
    const run = this.requireRun();
    this.items.set(itemResult.caseId, itemResult);
    await this.transport.recordItemResult(run, itemResult);
    await this.transport.recordScores(run, itemResult.caseId, itemResult.scores);
  }

  /** Attach a trace id to a (possibly already recorded) item, keeping its scores. */
  async attachTrace(caseId: string, traceId: string): Promise<void> {
    const run = this.requireRun();
    const merged = { ...this.itemOrEmpty(caseId), traceId };
    this.items.set(caseId, merged);
    await this.transport.recordItemResult(run, merged);
  }

  /** Add scores to an item (e.g. delayed/human), merging with existing scores. */
  async score(caseId: string, scores: Score[]): Promise<void> {
    const run = this.requireRun();
    const cur = this.itemOrEmpty(caseId);
    const merged = { ...cur, scores: [...cur.scores, ...scores] };
    this.items.set(caseId, merged);
    await this.transport.recordItemResult(run, merged);
    await this.transport.recordScores(run, caseId, merged.scores);
  }

  complete(): Promise<UploadState> {
    return this.transport.finishRun(this.requireRun(), null);
  }
  fail(): Promise<UploadState> {
    return this.transport.finishRun(this.requireRun(), 'failed');
  }
  cancel(): Promise<UploadState> {
    return this.transport.finishRun(this.requireRun(), 'cancelled');
  }

  // --- access ---
  item(caseId: string): EvalItemResult | undefined {
    return this.items.get(caseId);
  }
  private itemOrEmpty(caseId: string): EvalItemResult {
    return this.items.get(caseId) ?? emptyItem(caseId);
  }
}
