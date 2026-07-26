// src/eval/transport.ts — transport seam for offline evaluation (OE-8).
// Parity with traceroot-py/traceroot/eval/transport.py. The seam is async because a
// reporting transport does real HTTP; the local/fake ones just resolve immediately.

import type { EvalCase, Score } from './types';
import type { EvalItemResult, UploadState } from './results';

/** Opaque handle for one evaluation run, returned by createRun. */
export interface RunHandle {
  name: string;
  datasetName: string;
  metadata: Record<string, unknown> | null;
}

/** Result of Dataset.publish - explicit about local-only state. */
export interface PublishResult {
  status: 'local_only' | 'uploaded';
  datasetName: string;
  itemCount: number;
}

/** Persistence seam. Implementations must never fabricate remote URLs. */
export interface EvalTransport {
  /** Whether a run through this transport reports its per-case traces to the platform.
   *  The engine reads it for the trace-privacy boundary; local transports are false. */
  readonly reportsTraces?: boolean;
  /** Platform run id once a run is created (reporting transports only). */
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
  finishRun(run: RunHandle, status?: string | null): Promise<UploadState>;
  publishDataset(datasetName: string, itemCount: number): Promise<PublishResult>;
}

/** Default no-op transport. Everything stays local; nothing is uploaded. */
export class LocalTransport implements EvalTransport {
  readonly reportsTraces = false;
  async createRun(
    name: string,
    datasetName: string,
    metadata: Record<string, unknown> | null,
    _clientRunId?: string,
  ): Promise<RunHandle> {
    return { name, datasetName, metadata };
  }
  async registerItem(): Promise<void> {}
  async recordItemResult(): Promise<void> {}
  async recordScores(): Promise<void> {}
  async finishRun(_run: RunHandle, _status?: string | null): Promise<UploadState> {
    return { status: 'local_only', dashboardUrl: null };
  }
  async publishDataset(datasetName: string, itemCount: number): Promise<PublishResult> {
    return { status: 'local_only', datasetName, itemCount };
  }
}

/** Records every call in order for deterministic tests. Local-only. */
export class FakeTransport implements EvalTransport {
  readonly calls: unknown[][] = [];
  readonly reportsTraces: boolean;
  constructor(reportsTraces = false) {
    this.reportsTraces = reportsTraces;
  }

  async createRun(
    name: string,
    datasetName: string,
    metadata: Record<string, unknown> | null,
    _clientRunId?: string,
  ): Promise<RunHandle> {
    this.calls.push(['create_run', name, datasetName]);
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
  async finishRun(_run: RunHandle, _status?: string | null): Promise<UploadState> {
    this.calls.push(['finish_run']);
    return { status: 'local_only', dashboardUrl: null };
  }
  async publishDataset(datasetName: string, itemCount: number): Promise<PublishResult> {
    this.calls.push(['publish_dataset', datasetName]);
    return { status: 'local_only', datasetName, itemCount };
  }
}
