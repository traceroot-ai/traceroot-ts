// src/processor.ts
import { diag, trace as otelTrace, Attributes, Context, Span } from '@opentelemetry/api';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  LLM_MODEL_PARAMETERS,
  LLM_PROMPT,
  OI_LLM_MODEL_NAME,
  OI_SPAN_KIND,
  OI_TRACE_SESSION_ID,
  OI_TRACE_USER_ID,
  SPAN_METADATA,
  SpanAttributes,
  TRACE_METADATA,
} from './constants';
import { PROJECT_ID_ATTR, projectIdFromContext } from './project-id';
import type { Redact } from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

export const SDK_NAME = 'traceroot-ts';
export const SDK_VERSION = version;

let _hasWarnedUnattributedDrop = false;

// The traceroot.* keys that carry recorded content, so redact sees them.
/** @internal — exported for the key-classification guard test. */
export const REDACTABLE_KEYS = new Set([
  SPAN_METADATA,
  TRACE_METADATA,
  LLM_PROMPT,
  LLM_MODEL_PARAMETERS,
  SpanAttributes.EVAL_ERROR,
  SpanAttributes.EVAL_SCORE_COMMENT,
]);
const METADATA_KEYS = new Set([SPAN_METADATA, TRACE_METADATA]);
// Non-traceroot keys ingest reads for user, session, model, token usage, span kind and error
// grouping (mirrors backend/worker/otel_transform.py), held back so redact cannot drop them.
const HELD_BACK_KEYS = new Set([
  OI_TRACE_USER_ID,
  'session.user_id',
  OI_TRACE_SESSION_ID,
  OI_LLM_MODEL_NAME,
  'gen_ai.request.model',
  'gen_ai.system',
  'decision.model_name',
  'embedding.model_name',
  'ai.model.id',
  OI_SPAN_KIND,
  'gen_ai.operation.name',
  'ai.operationId',
  'operation.name',
  'exception.type',
]);
const HELD_BACK_PREFIXES = [
  'llm.token_count.',
  'gen_ai.usage.',
  'decision.token_count.',
  'ai.usage.',
];

/** @internal — reset warn-once state between tests. */
export function _resetProcessorState(): void {
  _hasWarnedUnattributedDrop = false;
}

export interface TraceRootSpanProcessorOptions {
  environment?: string;
  gitRepo?: string;
  gitRef?: string;
  globalAttributes?: Record<string, string | number | boolean>;
  /**
   * Drop spans that carry no traceroot.project_id attribute instead of exporting
   * them. Enabled in internal export mode when no process-default project id is
   * configured: an unroutable span must go nowhere — exporting it would either
   * poison the whole batch server-side or land it in a project it doesn't belong
   * to (cross-tenant safety).
   */
  dropSpansWithoutProjectId?: boolean;
  /**
   * Decide, per finished span, whether it is exported. Return false to drop
   * it; the span still ran, still parented its children, it just never leaves
   * the process. For spans a third-party library opens on the global tracer
   * that carry nothing a reader can use (a sandbox client's HTTP-call spans,
   * say). A throwing predicate counts as "export": tracing never breaks the
   * host over a filter.
   */
  exportSpan?: (span: ReadableSpan) => boolean;
  /**
   * Rewrite a finished span's attributes before export to TraceRoot, so
   * attributes, event attributes and status message sent to TraceRoot are rewritten (span name and resource are not); other exporters still see the
   * original span. Also runs on event attributes and the status message.
   * TraceRoot's bookkeeping keys (its own `traceroot.*` keys plus user,
   * session, model, token usage and span kind) are not passed in; recorded
   * input, output, metadata and prompt are. A function that throws or returns a non-object
   * (e.g. null or an array) fails closed: span and trace metadata are dropped,
   * and every other value except numbers and booleans is replaced. Eval results
   * uploaded to TraceRoot are redacted too; datasets and scorer definitions are
   * not.
   */
  redact?: Redact;
}

/**
 * Wraps an inner SpanProcessor and injects TraceRoot SDK metadata attributes
 * on every span start. The inner processor handles export batching and, when
 * the Vercel AI SDK is in use, OpenInference attribute enrichment.
 */
export class TraceRootSpanProcessor implements SpanProcessor {
  private readonly inner: SpanProcessor; // ← WIDENED from BatchSpanProcessor | SimpleSpanProcessor

  private readonly _environment: string | undefined;
  private readonly _gitRepo: string | undefined;
  private readonly _gitRef: string | undefined;
  private readonly _globalAttributes: Record<string, string | number | boolean> | undefined;
  // Keyed by spanId. Allows children to inherit paths even when the parent
  // is a NonRecordingSpan (remote context) with no attributes — which is
  // what OpenInference produces for LangGraph-instrumented node spans.
  private readonly _idsPathBySpanId = new Map<string, string[]>();
  private readonly _namePathBySpanId = new Map<string, string[]>();

  // Project id by spanId, so children created from an explicit parent handle —
  // where the active context does not carry the root's value — still inherit
  // their root's project id.
  private readonly _projectIdBySpanId = new Map<string, string>();

  private readonly _dropSpansWithoutProjectId: boolean;
  private readonly _exportSpan?: (span: ReadableSpan) => boolean;
  private readonly _redact?: Redact;

  constructor(
    inner: SpanProcessor, // ← WIDENED
    opts: TraceRootSpanProcessorOptions = {},
  ) {
    this.inner = inner;
    this._environment = opts.environment;
    this._gitRepo = opts.gitRepo;
    this._gitRef = opts.gitRef;
    this._globalAttributes = opts.globalAttributes;
    this._dropSpansWithoutProjectId = opts.dropSpansWithoutProjectId ?? false;
    this._exportSpan = opts.exportSpan;
    this._redact = opts.redact;
  }

  onStart(span: Span, parentContext: Context): void {
    span.setAttributes({
      'traceroot.sdk.name': SDK_NAME,
      'traceroot.sdk.version': SDK_VERSION,
    });
    if (this._environment !== undefined) {
      span.setAttribute('deployment.environment', this._environment); // back-compat
      span.setAttribute('traceroot.environment', this._environment); // key the backend transform reads
    }
    if (this._gitRepo !== undefined) {
      span.setAttribute('traceroot.git.repo', this._gitRepo);
    }
    if (this._gitRef !== undefined) {
      span.setAttribute('traceroot.git.ref', this._gitRef);
    }
    // Caller-supplied globals may override the sdk/environment/git keys above, but the
    // structural traceroot.span.* keys computed below stay SDK-owned.
    if (this._globalAttributes !== undefined) {
      span.setAttributes(this._globalAttributes);
    }

    // Enrich every span with its full name path from root to current span.
    // path[0] is always the root span name, so the backend can recover the
    // correct trace name even when child spans arrive before the root span.
    // Guard: a bare `{}` context (used in unit tests) has no getValue — skip gracefully.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isRealContext = typeof (parentContext as any)?.getValue === 'function';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentSpan = (isRealContext ? otelTrace.getSpan(parentContext) : undefined) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanName = ((span as any).name as string) ?? '';

    // `span.name` and `span.parentSpanId` are not on the public @opentelemetry/api
    // Span interface but are stable internal fields on the SDK implementation.
    const parentSpanId: string | undefined =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((span as any).parentSpanId as string | undefined) ||
      (parentSpan?.spanContext?.()?.spanId as string | undefined);

    // Project attribution: the OTel context the span was started under is primary
    // (descendants — including auto-instrumented spans — inherit it); the in-process
    // map covers children created from an explicit parent handle; and, when the
    // parent has already ended (its map entry was deleted in onEnd), fall back to
    // the project id already stamped on the parent span object itself — same trick
    // as the parentPath resolution below.
    const projectId =
      (isRealContext ? projectIdFromContext(parentContext) : undefined) ??
      (parentSpanId ? this._projectIdBySpanId.get(parentSpanId) : undefined) ??
      (parentSpan?.attributes?.[PROJECT_ID_ATTR] as string | undefined);
    if (projectId !== undefined) {
      span.setAttribute(PROJECT_ID_ATTR, projectId);
    }

    // Prefer the in-process map over span attributes: OpenInference creates
    // LangGraph node spans with a remote/NonRecordingSpan parent that carries
    // no attributes, so reading parentSpan.attributes would give undefined and
    // break the ancestry chain.
    const parentPath: string[] | undefined =
      (parentSpanId && this._namePathBySpanId.get(parentSpanId)) ||
      (parentSpan?.attributes?.['traceroot.span.path'] as string[] | undefined);
    const parentIdsPath: string[] | undefined =
      (parentSpanId && this._idsPathBySpanId.get(parentSpanId)) ||
      (parentSpan?.attributes?.['traceroot.span.ids_path'] as string[] | undefined);

    const spanPath: string[] = parentPath ? [...parentPath, spanName] : [spanName];
    // Gate on parentPath (not just parentSpanId) so path and ids_path stay in sync:
    // if path resolution failed (map miss + NonRecordingSpan), treat this span as a
    // root rather than emitting an inconsistent single-element path with a non-empty ids_path.
    const spanIdsPath: string[] =
      parentPath && parentSpanId
        ? parentIdsPath
          ? [...parentIdsPath, parentSpanId]
          : [parentSpanId]
        : [];

    span.setAttribute('traceroot.span.path', spanPath);
    span.setAttribute('traceroot.span.ids_path', spanIdsPath);

    // Store paths so descendant spans can inherit them via map lookup.
    const spanId =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof (span as any).spanContext === 'function' ? span.spanContext().spanId : undefined;
    if (spanId) {
      this._namePathBySpanId.set(spanId, spanPath);
      this._idsPathBySpanId.set(spanId, spanIdsPath);
      if (projectId !== undefined) this._projectIdBySpanId.set(spanId, projectId);
    }

    // Cast required: inner processor expects the internal sdk-trace-base Span,
    // but the SpanProcessor interface uses the public @opentelemetry/api Span.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.inner.onStart(span as any, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    // Invariant: children must be started before their parent ends. A child span
    // started after onEnd runs here loses the map-based ancestry lookup for
    // NonRecordingSpan parents (no attribute fallback exists for those).
    const spanId = span.spanContext().spanId;
    this._idsPathBySpanId.delete(spanId);
    this._namePathBySpanId.delete(spanId);
    this._projectIdBySpanId.delete(spanId);
    if (this._dropSpansWithoutProjectId && span.attributes[PROJECT_ID_ATTR] === undefined) {
      if (!_hasWarnedUnattributedDrop) {
        _hasWarnedUnattributedDrop = true;
        console.warn(
          `[TraceRoot] dropping span "${span.name}": no traceroot.project_id and no ` +
            'process-default project is configured, so it cannot be routed. ' +
            'Further drops will not be logged.',
        );
      }
      return;
    }
    if (this._exportSpan !== undefined && !shouldExport(this._exportSpan, span)) return;
    this.inner.onEnd(this._redact !== undefined ? redactedCopy(this._redact, span) : span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function shouldExport(predicate: (span: ReadableSpan) => boolean, span: ReadableSpan): boolean {
  try {
    return predicate(span) !== false;
  } catch (err) {
    diag.warn('[TraceRoot] exportSpan threw; exporting the span', err);
    return true;
  }
}

function isBookkeeping(key: string): boolean {
  if (key.startsWith('traceroot.')) return !REDACTABLE_KEYS.has(key);
  return HELD_BACK_KEYS.has(key) || HELD_BACK_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** @internal — the fail-closed rewrite, shared with eval result uploads. */
export function redactAttributes(redact: Redact, attributes: Attributes): Attributes {
  const ours: Attributes = {};
  const theirs: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    // Copy arrays so a redact that mutates one in place leaves the original span intact.
    (isBookkeeping(key) ? ours : theirs)[key] = Array.isArray(value) ? value.slice() : value;
  }
  let redacted: unknown;
  try {
    redacted = redact(theirs);
  } catch (err) {
    // Name only the error type: its message may quote the data being redacted.
    diag.warn(
      `[TraceRoot] redact threw ${err instanceof Error ? err.name : typeof err}; blanking attribute values`,
    );
    return blanked(theirs, ours);
  }
  if (typeof redacted !== 'object' || redacted === null || Array.isArray(redacted)) {
    diag.warn('[TraceRoot] redact returned a non-object; blanking attribute values');
    return blanked(theirs, ours);
  }
  return { ...redacted, ...ours };
}

// Metadata is dropped rather than blanked: ingest expects a JSON object there.
function blanked(theirs: Attributes, ours: Attributes): Attributes {
  const kept = Object.entries(theirs)
    .filter(([key]) => !METADATA_KEYS.has(key))
    .map(([key, value]) => [
      key,
      typeof value === 'number' || typeof value === 'boolean' ? value : '[redaction failed]',
    ]);
  return { ...Object.fromEntries(kept), ...ours };
}

function redactedCopy(redact: Redact, span: ReadableSpan): ReadableSpan {
  const { message } = span.status;
  const { 'otel.status_description': redactedMessage, ...attributes } = redactAttributes(
    redact,
    message ? { ...span.attributes, 'otel.status_description': message } : span.attributes,
  );
  // Object.create, not a spread: a spread loses spanContext() and the prototype getters.
  // Only TraceRoot's exporter receives this copy; other processors keep the original span.
  return Object.assign(Object.create(span), {
    attributes: { ...attributes, 'traceroot.redacted': true },
    events: span.events.map((event) =>
      event.attributes
        ? { ...event, attributes: redactAttributes(redact, event.attributes) }
        : event,
    ),
    status: {
      ...span.status,
      message: typeof redactedMessage === 'string' ? redactedMessage : undefined,
    },
  }) as ReadableSpan;
}
