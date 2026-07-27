// src/eval/evaluation.ts — reusable Evaluation definition (parity with
// traceroot-py/traceroot/eval/evaluation.py). A mutable, reusable definition (compose,
// reuse in CI, select a subset); run() produces an immutable EvalRunResult.

import { evaluateAsync, EvaluateOptions } from './engine';
import type { EvalRunResult } from './results';

export interface EvaluationOptions extends Omit<EvaluateOptions, 'dataset' | 'data'> {
  dataset: EvaluateOptions['dataset'];
  /** Not implemented in V1 (semantics deliberately deferred); passing it throws. */
  retry?: unknown;
}

/**
 * A reusable, code-level evaluation definition. Evaluation is cloud-only: every run reports
 * to the platform, which needs credentials and a synced dataset; pass `transport` to supply an
 * explicit one. `retry` is rejected rather than silently ignored.
 */
export class Evaluation {
  private readonly opts: EvaluateOptions;
  readonly name: string;
  readonly dataset: EvaluateOptions['dataset'];
  readonly candidateVersion?: string;
  readonly select?: (c: import('./types').EvalCase) => boolean;

  constructor(options: EvaluationOptions) {
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
    this.select = rest.select;
  }

  run(overrides: Partial<EvaluateOptions> = {}): Promise<EvalRunResult> {
    return evaluateAsync({ ...this.opts, ...overrides });
  }
}
