// src/trace-id.ts — deterministic trace-id forcing (internal export mode only).
//
// The forced id travels in AsyncLocalStorage so concurrent roots cannot see each
// other's ids, and ContextIdGenerator returns it when OTel generates a ROOT's trace
// id (children inherit and never ask). The internal-mode flag lives here — not in
// traceroot.ts — because observe.ts must read it and traceroot.ts already imports
// from observe.ts; a static import in the other direction would be a require cycle.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Span } from '@opentelemetry/api';
import { IdGenerator, RandomIdGenerator } from '@opentelemetry/sdk-trace-base';

const HEX32 = /^[0-9a-f]{32}$/;
const INVALID_TRACE_ID = '00000000000000000000000000000000';

const _forcedTraceId = new AsyncLocalStorage<string>();
let _internalMode = false;
let _hasWarnedForceFailed = false;

/** Throws TypeError unless `traceId` is a lowercase 32-hex string (not the zero sentinel). */
export function assertValidTraceId(traceId: string): void {
  if (!HEX32.test(traceId) || traceId === INVALID_TRACE_ID) {
    throw new TypeError(
      `[TraceRoot] traceId must be a lowercase 32-hex string, got: ${JSON.stringify(traceId)}`,
    );
  }
}

/**
 * IdGenerator honoring a context-scoped forced trace id. Roots created inside a
 * withForcedTraceId() scope get that id; everything else falls through to random,
 * identical to the OTel default. Installed on the provider only in internal mode.
 */
export class ContextIdGenerator implements IdGenerator {
  private readonly _inner = new RandomIdGenerator();
  generateTraceId(): string {
    return _forcedTraceId.getStore() ?? this._inner.generateTraceId();
  }
  generateSpanId(): string {
    return this._inner.generateSpanId();
  }
}

/**
 * Run fn with `traceId` visible to ContextIdGenerator. The root span must be created
 * inside fn — synchronously or within the same async continuation.
 */
export function withForcedTraceId<T>(traceId: string, fn: () => T): T {
  return _forcedTraceId.run(traceId, fn);
}

/**
 * Validate + gate a forced trace id. Throws TypeError on a malformed id in ANY mode
 * (a bad id is a programming error). Returns true when forcing should proceed;
 * outside internal export mode, warns and returns false so callers fall back to
 * fully normal behavior.
 */
export function shouldForceTraceId(traceId: string): boolean {
  assertValidTraceId(traceId);
  if (!_internalMode) {
    console.warn(
      '[TraceRoot] traceId forcing is only honored in internal export mode; ignoring forced id.',
    );
    return false;
  }
  return true;
}

/**
 * Warn (once per process) when a span that should carry a forced trace id came out
 * with a different one. This happens when the globally registered tracer provider
 * does not use ContextIdGenerator — e.g. the application registered its own OTel
 * provider before TraceRoot.initialize(), whose register() then lost the race.
 * Spans are still recorded, just with random trace ids.
 */
export function warnIfForcingFailed(expected: string, span: Span): void {
  if (span.spanContext().traceId === expected || _hasWarnedForceFailed) return;
  _hasWarnedForceFailed = true;
  console.warn(
    '[TraceRoot] forced traceId was not applied: the global tracer provider does not use ' +
      "TraceRoot's id generator (was another provider registered before TraceRoot.initialize()?). " +
      'Spans will get random trace ids.',
  );
}

export function isInternalMode(): boolean {
  return _internalMode;
}

/** @internal — set by TraceRoot.initialize()/shutdown() and test resets. */
export function _setInternalMode(v: boolean): void {
  _internalMode = v;
}

/** @internal — reset warn-once state between tests. */
export function _resetTraceIdState(): void {
  _hasWarnedForceFailed = false;
}
