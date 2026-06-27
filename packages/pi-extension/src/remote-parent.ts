// Build an OTel Context that carries a remote parent SpanContext, so a new span
// joins an existing trace (cross-process / subagent nesting and reload/resume
// continuation). Returns undefined when the ids are not well-formed OTel ids, so
// the caller falls back to a fresh root rather than emitting a corrupt span.
import { ROOT_CONTEXT, TraceFlags, trace, type Context } from '@opentelemetry/api';
import { isSpanId, isTraceId } from './hex.ts';

export function remoteParentContext(
  traceId: string | null | undefined,
  spanId: string | null | undefined,
): Context | undefined {
  if (!isTraceId(traceId) || !isSpanId(spanId)) return undefined;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}
