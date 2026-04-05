// src/observe.ts
import { context, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { getAttributesFromContext } from '@arizeai/openinference-core';
import {
  INPUT_VALUE,
  OUTPUT_VALUE,
  SemanticConventions,
  SESSION_ID,
  USER_ID,
} from '@arizeai/openinference-semantic-conventions';
import { SPAN_METADATA, SPAN_TAGS } from './constants';
import { ObserveOptions, SpanType } from './types';
import { captureSourceLocation } from './git_context';

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND;

const SPAN_KIND_MAP: Record<SpanType, string> = {
  agent: 'AGENT',
  tool: 'TOOL',
  llm: 'LLM',
  span: 'CHAIN',
};

// Cached once after the first call; the tracer name never changes.
let _tracer: ReturnType<typeof trace.getTracer> | undefined;
let _hasWarnedUninit = false;

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor as FunctionConstructor;

/** Returns true if fn is declared as `async function*` — without calling it. */
function isAsyncGeneratorFunction(fn: unknown): boolean {
  return typeof fn === 'function' && fn instanceof AsyncGeneratorFunction;
}

/** Returns true if v is an async generator object (already running). */
function isAsyncGeneratorObject(v: unknown): v is AsyncGenerator {
  return (
    v != null &&
    typeof v === 'object' &&
    typeof (v as AsyncGenerator)[Symbol.asyncIterator] === 'function' &&
    typeof (v as AsyncGenerator).next === 'function'
  );
}

/** Serialize a value for a span attribute, returning undefined on failure. */
function trySerialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
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
  // Auto-initialize from env if SDK not yet initialized.
  if (process.env['TRACEROOT_API_KEY']) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TraceRoot } = require('./traceroot') as typeof import('./traceroot');
    if (!TraceRoot.isInitialized()) {
      TraceRoot.initialize();
    }
  }

  const name = options.name ?? (fn.name || 'anonymous');
  _tracer ??= trace.getTracer('traceroot-ts');

  if (isAsyncGeneratorFunction(fn)) {
    return _observeAsyncGenerator(
      name,
      options,
      fn as (...args: A) => AsyncGenerator<T>,
      args,
    );
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
  _tracer ??= trace.getTracer('traceroot-ts');

  return _tracer.startActiveSpan(name, async (span) => {
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
      _applyCommonAttributes(span, options, args);

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
  });
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
  _tracer ??= trace.getTracer('traceroot-ts');
  const span = _tracer.startSpan(name);

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

  _applyCommonAttributes(span, options, args);

  const collected: T[] = [];
  try {
    for await (const item of fn(...args)) {
      collected.push(item);
      yield item;
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

/**
 * Apply attributes common to all span types: kind, ambient context, session/user,
 * input from args, metadata, tags, git source location.
 */
function _applyCommonAttributes(
  span: Span,
  options: ObserveOptions,
  args: unknown[],
): void {
  span.setAttribute(OPENINFERENCE_SPAN_KIND, SPAN_KIND_MAP[options.type ?? 'span']);

  // Propagate any ambient attributes set by usingAttributes() in the call stack.
  const ctxAttrs = getAttributesFromContext(context.active());
  if (ctxAttrs && Object.keys(ctxAttrs).length > 0) {
    span.setAttributes(ctxAttrs);
  }

  if (options.sessionId !== undefined) span.setAttribute(SESSION_ID, options.sessionId);
  if (options.userId !== undefined) span.setAttribute(USER_ID, options.userId);

  // Auto-capture input from args. Single arg → use directly; multiple → array.
  if (options.captureInput !== false && args.length > 0) {
    const inputValue = args.length === 1 ? args[0] : args;
    const serialized = trySerialize(inputValue);
    if (serialized !== undefined) span.setAttribute(INPUT_VALUE, serialized);
  }

  if (options.metadata !== undefined) {
    const s = trySerialize(options.metadata);
    if (s !== undefined) span.setAttribute(SPAN_METADATA, s);
  }
  if (options.tags !== undefined) {
    const s = trySerialize(options.tags);
    if (s !== undefined) span.setAttribute(SPAN_TAGS, s);
  }

  const loc = captureSourceLocation();
  if (loc.file !== undefined) span.setAttribute('traceroot.git.source_file', loc.file);
  if (loc.line !== undefined) span.setAttribute('traceroot.git.source_line', loc.line);
  if (loc.functionName !== undefined) span.setAttribute('traceroot.git.source_function', loc.functionName);
}

/** @internal — reset module state between tests */
export function _resetObserveState(): void {
  _tracer = undefined;
  _hasWarnedUninit = false;
}
