// src/observe.ts
import { context, ROOT_CONTEXT, Span as OtelSpan, SpanStatusCode, trace } from '@opentelemetry/api';
import { OUTPUT_VALUE } from '@arizeai/openinference-semantic-conventions';
import { applyCommonAttributes, trySerialize } from './attributes';
import { ObserveOptions } from './types';
import { shouldForceTraceId, withForcedTraceId, assertValidTraceId } from './trace-id';

// Cached once after the first call; the tracer name never changes.
let _tracer: ReturnType<typeof trace.getTracer> | undefined;
let _hasWarnedUninit = false;

const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {})
  .constructor as FunctionConstructor;

/** Returns true if fn is declared as `async function*` — without calling it. */
function isAsyncGeneratorFunction(fn: unknown): boolean {
  return typeof fn === 'function' && fn instanceof AsyncGeneratorFunction;
}

/**
 * Wraps fn(...args) in an OpenTelemetry span, auto-capturing arguments as input
 * and the return value as output using OpenInference semconv.
 *
 * API: observe(options, fn, ...args)
 * - Input is auto-captured from args (single arg → direct value, multiple → array).
 *   Pass captureInput: false to suppress.
 * - Output is auto-captured from the return value (pass captureOutput: false to suppress).
 * - If fn is an async generator function, the span stays open until the generator is
 *   exhausted and all yielded items are collected as output.
 * - Nested calls automatically become child spans via AsyncLocalStorage context propagation.
 * - Works as a no-op if TraceRoot is not initialized. Auto-initializes if TRACEROOT_API_KEY is set.
 *
 * @example
 * // Auto-capture args as input, return value as output:
 * const result = await observe({ name: 'search', type: 'tool' }, search, query, k);
 *
 * // Zero-arg thunk (backward compat — no input captured):
 * const result = await observe({ name: 'work' }, async () => doWork());
 *
 * // Suppress PII input or large output:
 * await observe({ name: 'handle', captureInput: false, captureOutput: false }, fn, arg);
 *
 * // Associate with a session/user:
 * await observe({ name: 'chat', sessionId: 'sess-123', userId: 'user-abc' }, handler, msg);
 */
// Overload 1: async generator fn → returns AsyncGenerator (so caller can iterate)
export function observe<A extends unknown[], T>(
  options: ObserveOptions,
  fn: (...args: A) => AsyncGenerator<T>,
  ...args: A
): AsyncGenerator<T>;

// Overload 2: regular fn → returns Promise
export function observe<A extends unknown[], T>(
  options: ObserveOptions,
  fn: (...args: A) => T | Promise<T>,
  ...args: A
): Promise<T>;

// Implementation
export function observe<A extends unknown[], T>(
  options: ObserveOptions,
  fn: (...args: A) => T | Promise<T> | AsyncGenerator<T>,
  ...args: A
): Promise<T> | AsyncGenerator<T> {
  const name = options.name ?? (fn.name || 'anonymous');
  if (options.traceId !== undefined) assertValidTraceId(options.traceId);
  _tracer ??= trace.getTracer('traceroot-ts');

  if (isAsyncGeneratorFunction(fn)) {
    return _observeAsyncGenerator(name, options, fn as (...args: A) => AsyncGenerator<T>, args);
  }

  return _observeRegular(name, options, fn as (...args: A) => T | Promise<T>, args);
}

/** Handle a regular (non-generator) function. fn is called inside the span. */
async function _observeRegular<A extends unknown[], T>(
  name: string,
  options: ObserveOptions,
  fn: (...args: A) => T | Promise<T>,
  args: A,
): Promise<T> {
  if (process.env['TRACEROOT_API_KEY']) {
    const { TraceRoot } = await import('./traceroot');
    if (!TraceRoot.isInitialized()) TraceRoot.initialize();
  }
  _tracer ??= trace.getTracer('traceroot-ts');
  const tracer = _tracer;
  const forcedId = options.traceId;

  const run = async (span: OtelSpan) => {
    if (!span.isRecording()) {
      if (!_hasWarnedUninit) {
        _hasWarnedUninit = true;
        console.warn(
          '[TraceRoot] observe() called but TraceRoot.initialize() was not called. Spans will not be recorded.',
        );
      }
      try {
        return await fn(...args);
      } finally {
        span.end();
      }
    }

    try {
      applyCommonAttributes(span, options, args);

      const result = await fn(...args);

      if (options.captureOutput !== false) {
        const serialized = trySerialize(result);
        if (serialized !== undefined) span.setAttribute(OUTPUT_VALUE, serialized);
      }
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  };

  if (forcedId !== undefined && shouldForceTraceId(forcedId)) {
    // ROOT_CONTEXT: an ambient active span would otherwise parent this span and the
    // generator would never be asked for a trace id.
    return withForcedTraceId(forcedId, () => tracer.startActiveSpan(name, {}, ROOT_CONTEXT, run));
  }
  return tracer.startActiveSpan(name, run);
}

/**
 * Handle an async generator fn: manually manage the span so it stays open
 * across yields. Returns an AsyncGenerator the caller can iterate.
 */
async function* _observeAsyncGenerator<A extends unknown[], T>(
  name: string,
  options: ObserveOptions,
  fn: (...args: A) => AsyncGenerator<T>,
  args: A,
): AsyncGenerator<T> {
  if (process.env['TRACEROOT_API_KEY']) {
    const { TraceRoot } = await import('./traceroot');
    if (!TraceRoot.isInitialized()) TraceRoot.initialize();
  }
  _tracer ??= trace.getTracer('traceroot-ts');
  const tracer = _tracer;
  const forcedId = options.traceId;
  const span =
    forcedId !== undefined && shouldForceTraceId(forcedId)
      ? withForcedTraceId(forcedId, () => tracer.startSpan(name, undefined, ROOT_CONTEXT))
      : tracer.startSpan(name);

  if (!span.isRecording()) {
    if (!_hasWarnedUninit) {
      _hasWarnedUninit = true;
      console.warn(
        '[TraceRoot] observe() called but TraceRoot.initialize() was not called. Spans will not be recorded.',
      );
    }
    yield* fn(...args);
    return;
  }

  applyCommonAttributes(span, options, args);

  // Activate the span in the OTel context so that updateCurrentSpan() and
  // nested observe() calls inside the generator body target the correct span.
  // We must wrap each .next() call in context.with() because AsyncLocalStorage
  // does not preserve context across generator yield boundaries when resumed
  // from outside the original run scope.
  const spanCtx = trace.setSpan(context.active(), span);
  const innerGen = fn(...args);

  const collected: T[] = [];
  try {
    while (true) {
      const { value, done } = await context.with(spanCtx, () => innerGen.next());
      if (done) break;
      collected.push(value as T);
      yield value as T;
    }
    if (options.captureOutput !== false && collected.length > 0) {
      const serialized = trySerialize(collected);
      if (serialized !== undefined) span.setAttribute(OUTPUT_VALUE, serialized);
    }
  } catch (err) {
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

/** @internal — reset module state between tests */
export function _resetObserveState(): void {
  _tracer = undefined;
  _hasWarnedUninit = false;
}
