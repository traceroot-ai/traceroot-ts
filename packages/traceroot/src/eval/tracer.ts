// src/eval/tracer.ts — the tracer used for evaluation structural spans.
//
// Parity with Python `traceroot/eval/engine.py::_eval_tracer`. A REPORTED run exports its per-case
// spans through the global production tracer, which are then linked to the reported results. A
// LOCAL run gets a non-exporting tracer instead: the span tree still drives the run, but the case
// inputs and task outputs it carries never leave the process.

import { ProxyTracerProvider, trace, type Tracer } from '@opentelemetry/api';
import { TraceRoot } from '../traceroot';

const EVAL_TRACER_NAME = 'traceroot-ts';

// A ProxyTracerProvider with no delegate hands out the OTel API's own no-op tracers ("Before a
// delegate is set, tracers provided are NoOp"), and this one never gets a delegate. Spans still
// start/nest/end so the engine's structure is unchanged, but nothing is recorded and nothing can
// reach an exporter — whatever the globally registered provider is.
const nonExporting: Tracer = new ProxyTracerProvider().getTracer(EVAL_TRACER_NAME);

/**
 * The tracer for evaluation spans. `local` selects the non-exporting tracer: a local run must not
 * ship its case payloads as span I/O, and it also must not initialize the exporting SDK.
 */
export function evalTracer(local = false): Tracer {
  if (local) return nonExporting;
  if (process.env['TRACEROOT_API_KEY'] && !TraceRoot.isInitialized()) {
    TraceRoot.initialize();
  }
  return trace.getTracer(EVAL_TRACER_NAME);
}

/** @internal test reset (no-op; retained for test compatibility) */
export function _resetEvalTracer(): void {}
