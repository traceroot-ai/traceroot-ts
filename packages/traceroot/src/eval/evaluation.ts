// src/eval/evaluation.ts — reusable Evaluation definition (parity with
// traceroot-py/traceroot/eval/evaluation.py). A mutable, reusable definition (compose,
// reuse in CI, select a subset); run() produces an immutable EvalRunResult.

import { evaluateAsync, EvaluateOptions, LOCAL_AND_TRANSPORT } from './engine';
import type { EvalRunResult } from './results';

export interface EvaluationOptions extends Omit<EvaluateOptions, 'dataset' | 'data'> {
  dataset: EvaluateOptions['dataset'];
  /** Not implemented in V1 (semantics deliberately deferred); passing it throws. */
  retry?: unknown;
}

/**
 * A reusable, code-level evaluation definition. Evaluation is cloud-only: every run reports
 * to the platform, which needs credentials and a synced dataset; pass `transport` to supply an
 * explicit one, or `local: true` to run in full and report nowhere. `retry` is rejected rather
 * than silently ignored.
 */
export class Evaluation {
  private readonly opts: EvaluateOptions;
  readonly name: string;
  readonly dataset: EvaluateOptions['dataset'];
  readonly candidateVersion?: string;
  readonly scorers: EvaluateOptions['scorers'];
  readonly select?: (c: import('./types').EvalCase) => boolean;

  /** `local: true` and an explicit `transport` are a contradiction, wherever they meet: the
   *  constructor, or a run() override merged onto a definition that validated cleanly. */
  private static rejectLocalWithTransport(options: Partial<EvaluateOptions>): void {
    if (options.local === true && options.transport !== undefined) {
      throw new Error(LOCAL_AND_TRANSPORT);
    }
  }

  constructor(options: EvaluationOptions) {
    Evaluation.rejectLocalWithTransport(options);
    if (options.retry !== undefined && options.retry !== null) {
      throw new Error(
        'retry is not implemented in V1 (its semantics are deliberately deferred). ' +
          'Handle retries inside the task, or omit retry.',
      );
    }
    const { retry: _retry, ...rest } = options;
    this.opts = rest;
    this.name = rest.name;
    this.dataset = rest.dataset;
    this.candidateVersion = rest.candidateVersion;
    this.scorers = rest.scorers;
    this.select = rest.select;
  }

  run(overrides: Partial<EvaluateOptions> = {}): Promise<EvalRunResult> {
    // Validate the MERGED options, not the definition's: `run({ transport })` on a local
    // definition (or `run({ local: true })` on one with a transport) is the same contradiction
    // the constructor rejects, and it must fail the same way — at the call, not inside the engine.
    const merged = { ...this.opts, ...overrides };
    Evaluation.rejectLocalWithTransport(merged);
    return evaluateAsync(merged);
  }
}
