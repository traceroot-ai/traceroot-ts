// src/eval/tracer.ts — the tracer used for evaluation structural spans.
//
// Parity with Python `traceroot/eval/engine.py::_eval_tracer`. This is the layer that
// enforces the trace-privacy boundary for LOCAL evaluations: a local run's eval spans
// are created on a private, non-exporting provider and the global exporting provider is
// never initialized by the eval path — so neither the eval spans nor any nested
// application spans (created via the global tracer) can reach the OTLP endpoint just
// because TRACEROOT_API_KEY happens to be set.

import { trace, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { AlwaysOffSampler } from '@opentelemetry/sdk-trace-base';
import { TraceRoot } from '../traceroot';

const EVAL_TRACER_NAME = 'traceroot-ts';

// Lazily constructed private provider. It has NO span processors and NO exporter, and is
// never registered globally, so spans it creates cannot be exported. The AlwaysOff
// sampler makes its spans non-recording while still giving them a valid span context, so
// nested application spans still parent to the eval tree (and, under the global default
// ParentBased sampler, are themselves dropped).
let _localEvalProvider: NodeTracerProvider | undefined;

/**
 * Return the tracer for evaluation spans, honoring the trace-privacy boundary.
 *
 * Reported run -> the global production tracer, so per-case eval spans export and can be
 * linked to reported results (initializes the global provider if credentials exist).
 *
 * Local run -> a private, non-exporting provider. The global exporting provider is NOT
 * initialized here.
 */
export function evalTracer(reporting: boolean): Tracer {
  if (reporting) {
    if (process.env['TRACEROOT_API_KEY'] && !TraceRoot.isInitialized()) {
      TraceRoot.initialize();
    }
    return trace.getTracer(EVAL_TRACER_NAME);
  }
  if (!_localEvalProvider) {
    _localEvalProvider = new NodeTracerProvider({ sampler: new AlwaysOffSampler() });
  }
  return _localEvalProvider.getTracer(EVAL_TRACER_NAME);
}

/** @internal test reset */
export function _resetEvalTracer(): void {
  _localEvalProvider = undefined;
}
