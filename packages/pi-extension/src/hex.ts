// Validate OpenTelemetry id strings: lowercase hex, 32 chars for a trace id and
// 16 for a span id. Used wherever an id read from an untrusted source (persisted
// file, env var) is turned into a SpanContext.
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
// All-zero is the W3C Trace Context "invalid" sentinel for both ids; reject it so it can
// never be turned into a parent SpanContext.
const ALL_ZERO = /^0+$/;

export function isTraceId(value: string | null | undefined): value is string {
  return typeof value === 'string' && TRACE_ID.test(value) && !ALL_ZERO.test(value);
}

export function isSpanId(value: string | null | undefined): value is string {
  return typeof value === 'string' && SPAN_ID.test(value) && !ALL_ZERO.test(value);
}
