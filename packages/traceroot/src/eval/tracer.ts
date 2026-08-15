// src/eval/tracer.ts — the tracer used for evaluation structural spans.
//
// Parity with Python `traceroot/eval/engine.py::_eval_tracer`. Evaluation is cloud-only, so a
// run always exports its per-case spans through the global production tracer, which are then
// linked to the reported results.

import { trace, type Tracer } from '@opentelemetry/api';
import { TraceRoot } from '../traceroot';

const EVAL_TRACER_NAME = 'traceroot-ts';

/** The global production tracer for evaluation spans (initializes it if credentials exist). */
export function evalTracer(): Tracer {
  if (process.env['TRACEROOT_API_KEY'] && !TraceRoot.isInitialized()) {
    TraceRoot.initialize();
  }
  return trace.getTracer(EVAL_TRACER_NAME);
}

/** @internal test reset (no-op; retained for test compatibility) */
export function _resetEvalTracer(): void {}
