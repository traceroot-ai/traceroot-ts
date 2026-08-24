// src/observe.ts
import { context, Context, Span as OtelSpan, SpanStatusCode, trace } from '@opentelemetry/api';
import { isTracingSuppressed } from '@opentelemetry/core';
import { OUTPUT_VALUE } from '@arizeai/openinference-semantic-conventions';
import { applyCommonAttributes, trySerialize } from './attributes';
import { _isGlobalAutoInitSuppressed } from './spans';
import { ObserveOptions } from './types';
import {
  assertValidTraceId,
  forcedTraceRootContext,
  shouldForceTraceId,
  warnIfForcingFailed,
  withForcedTraceId,
} from './trace-id';
import { assertValidProjectId, contextWithProjectId, shouldAttachProjectId } from './project-id';

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
  if (options.projectId !== undefined) assertValidProjectId(options.projectId);
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
  if (process.env['TRACEROOT_API_KEY'] && !_isGlobalAutoInitSuppressed()) {
    const { TraceRoot } = await import('./traceroot');
    if (!TraceRoot.isInitialized()) TraceRoot.initialize();
  }
  _tracer ??= trace.getTracer('traceroot-ts');
  const tracer = _tracer;
  const forcedId = options.traceId;
  // `undefined` when absent OR gated off (public mode) — a plain const so the
  // narrowing survives into the closure below.
  const attachedProjectId =
    options.projectId !== undefined && shouldAttachProjectId(options.projectId)
      ? options.projectId
      : undefined;
  const withProjectId = (base: Context): Context =>
    attachedProjectId !== undefined ? contextWithProjectId(base, attachedProjectId) : base;

  const run = async (span: OtelSpan) => {
    if (!span.isRecording()) {
      // A span that is non-recording because the active context is suppressed (any
      // observe() call made from inside a local eval run's task) is a deliberate
      // choice, not a forgotten initialize() -- same exemption as startSpan()'s
      // analogous guard in spans.ts.
      if (!isTracingSuppressed(context.active()) && !_hasWarnedUninit) {
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
    // Force the id around span CREATION only, then run the callback inside the span's
    // context. Wrapping the whole callback would leave the forced id visible (via
    // AsyncLocalStorage, which survives await) to any root a user creates inside fn.
    // forcedTraceRootContext(): ROOT_CONTEXT so no ambient span parents this root, but
    // carrying forward a local eval run's suppression flag if the caller's active
    // context has one (see trace-id.ts) — otherwise a forced-id observe() call inside a
    // local run would export despite the run's suppression.
    const rootCtx = forcedTraceRootContext();
    const span = withForcedTraceId(forcedId, () =>
      tracer.startSpan(name, undefined, withProjectId(rootCtx)),
    );
    if (span.isRecording()) warnIfForcingFailed(forcedId, span);
    // withProjectId so the root and its descendants carry the project attribution; the
    // callback body runs under the SAME base as the span itself, so a nested span/
    // observe() call created inside fn() inherits both the project id and (if present)
    // the suppression flag rather than escaping it via a second bare ROOT_CONTEXT.
    return context.with(trace.setSpan(withProjectId(rootCtx), span), () => run(span));
  }
  if (attachedProjectId !== undefined) {
    return tracer.startActiveSpan(name, {}, withProjectId(context.active()), run);
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
  if (process.env['TRACEROOT_API_KEY'] && !_isGlobalAutoInitSuppressed()) {
    const { TraceRoot } = await import('./traceroot');
    if (!TraceRoot.isInitialized()) TraceRoot.initialize();
  }
  _tracer ??= trace.getTracer('traceroot-ts');
  const tracer = _tracer;
  const forcedId = options.traceId;
  const attachedProjectId =
    options.projectId !== undefined && shouldAttachProjectId(options.projectId)
      ? options.projectId
      : undefined;
  const withProjectId = (base: Context): Context =>
    attachedProjectId !== undefined ? contextWithProjectId(base, attachedProjectId) : base;
  const force = forcedId !== undefined && shouldForceTraceId(forcedId);
  const span = force
    ? withForcedTraceId(forcedId, () =>
        tracer.startSpan(name, undefined, withProjectId(forcedTraceRootContext())),
      )
    : attachedProjectId !== undefined
      ? tracer.startSpan(name, undefined, withProjectId(context.active()))
      : tracer.startSpan(name);
  if (force && span.isRecording()) warnIfForcingFailed(forcedId, span);

  if (!span.isRecording()) {
    if (!isTracingSuppressed(context.active()) && !_hasWarnedUninit) {
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
  // Carry the project id into the children's context too — the generator's span
  // context is rebuilt from context.active(), which does not include the value
  // the root was started under.
  const spanCtx = trace.setSpan(withProjectId(context.active()), span);
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
