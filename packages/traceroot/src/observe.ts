// src/observe.ts
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  INPUT_VALUE,
  OUTPUT_VALUE,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND;
import { ObserveOptions, SpanType } from './types';

const SPAN_KIND_MAP: Record<SpanType, string> = {
  agent: 'AGENT',
  tool: 'TOOL',
  llm: 'LLM',
  span: 'CHAIN',
};

// Cached once after the first call; the tracer name never changes.
let _tracer: ReturnType<typeof trace.getTracer> | undefined;
let _hasWarnedUninit = false;

/**
 * Wraps fn() in an OpenTelemetry span, capturing input/output using
 * OpenInference semconv. Nested calls automatically become child spans
 * via AsyncLocalStorage context propagation.
 *
 * Works as a no-op (calls fn() untraced) if no OTel TracerProvider is registered.
 * Warns once to console in that case.
 */
export async function observe<T>(
  options: ObserveOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  const name = options.name ?? (fn.name || 'anonymous');
  _tracer ??= trace.getTracer('traceroot-ts');

  return _tracer.startActiveSpan(name, async (span) => {
    if (!span.isRecording()) {
      if (!_hasWarnedUninit) {
        _hasWarnedUninit = true;
        console.warn(
          '[TraceRoot] observe() called but TraceRoot.initialize() was not called. Spans will not be recorded.',
        );
      }
      // No-op path: just run fn() and return.
      try {
        return await fn();
      } finally {
        span.end();
      }
    }

    try {
      span.setAttribute(OPENINFERENCE_SPAN_KIND, SPAN_KIND_MAP[options.type ?? 'span']);

      if (options.input !== undefined) {
        try {
          span.setAttribute(INPUT_VALUE, JSON.stringify(options.input));
        } catch {
          // Non-serializable input — skip attribute
        }
      }

      const result = await fn();

      try {
        span.setAttribute(OUTPUT_VALUE, JSON.stringify(result));
      } catch {
        // Non-serializable output — skip attribute
      }
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** @internal — reset module state between tests */
export function _resetObserveState(): void {
  _tracer = undefined;
  _hasWarnedUninit = false;
}
