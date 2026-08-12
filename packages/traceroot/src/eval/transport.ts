// src/eval/transport.ts — transport seam for offline evaluation.
// Parity with traceroot-py/traceroot/eval/transport.py. Evaluation is cloud-only: every run
// reports through a PlatformTransport. This defines the seam plus a recording FakeTransport
// (a non-network stand-in cloud transport) for deterministic tests.

import type { EvalCase, Score } from './types';
import type { EvalItemResult, UploadState } from './results';

/**
 * The evaluation ran, but the run could not be finalized on the platform.
 *
 * Thrown ONLY when the run itself succeeded. A completion failure never replaces the error a run
 * already failed with — that one propagates, carrying the completion failure on its
 * `completionError` property — so the real cause is never buried under a 400 from /complete. The
 * underlying transport error is held as data rather than as `cause`, so the user reads one error
 * instead of a chain.
 */
export class EvalCompletionError extends Error {
  constructor(
    message: string,
    readonly completionError: unknown,
  ) {
    super(message);
    this.name = 'EvalCompletionError';
  }
}

/** Opaque handle for one evaluation run, returned by createRun. */
export interface RunHandle {
  name: string;
  datasetName: string;
  metadata: Record<string, unknown> | null;
}

/** Result of the dataset publish seam. */
export interface PublishResult {
  status: 'local_only' | 'uploaded';
  datasetName: string;
  itemCount: number;
}

/** Persistence seam. Implementations must never fabricate remote URLs. */
export interface EvalTransport {
  /** Platform run id once a run is created. */
  readonly runId?: string | null;
  createRun(
    name: string,
    datasetName: string,
    metadata: Record<string, unknown> | null,
    clientRunId?: string,
  ): Promise<RunHandle>;
  registerItem(run: RunHandle, evalCase: EvalCase): Promise<void>;
  recordItemResult(run: RunHandle, itemResult: EvalItemResult): Promise<void>;
  recordScores(run: RunHandle, caseId: string, scores: Score[]): Promise<void>;
  finishRun(
    run: RunHandle,
    status?: string | null,
    emittedMetrics?: Record<string, string[]> | null,
  ): Promise<UploadState>;
  publishDataset(datasetName: string, itemCount: number): Promise<PublishResult>;
}

/** Records every call in order for deterministic tests -- a stand-in cloud transport
 *  (spans export as on a reported run; no real HTTP). */
export class FakeTransport implements EvalTransport {
  readonly calls: unknown[][] = [];
  lastRunMetadata: Record<string, unknown> | null = null;

  async createRun(
    name: string,
    datasetName: string,
    metadata: Record<string, unknown> | null,
    _clientRunId?: string,
  ): Promise<RunHandle> {
    this.calls.push(['create_run', name, datasetName]);
    this.lastRunMetadata = metadata;
    return { name, datasetName, metadata };
  }
  async registerItem(_run: RunHandle, evalCase: EvalCase): Promise<void> {
    this.calls.push(['register_item', evalCase.id]);
  }
  async recordItemResult(_run: RunHandle, itemResult: EvalItemResult): Promise<void> {
    this.calls.push(['record_item_result', itemResult.caseId]);
  }
  async recordScores(_run: RunHandle, caseId: string): Promise<void> {
    this.calls.push(['record_scores', caseId]);
  }
  lastFinishStatus: string | null | undefined = undefined;
  lastEmittedMetrics: Record<string, string[]> | null | undefined = undefined;
  async finishRun(
    _run: RunHandle,
    status?: string | null,
    emittedMetrics?: Record<string, string[]> | null,
  ): Promise<UploadState> {
    this.calls.push(['finish_run', status ?? null]);
    this.lastFinishStatus = status ?? null;
    this.lastEmittedMetrics = emittedMetrics ?? null;
    return { status: 'uploaded', dashboardUrl: null };
  }
  async publishDataset(datasetName: string, itemCount: number): Promise<PublishResult> {
    this.calls.push(['publish_dataset', datasetName]);
    return { status: 'local_only', datasetName, itemCount };
  }
}
