// src/processor.ts
import { trace as otelTrace, Context, Span } from '@opentelemetry/api';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

export const SDK_NAME = 'traceroot-ts';
export const SDK_VERSION = version;

export interface TraceRootSpanProcessorOptions {
  environment?: string;
  gitRepo?: string;
  gitRef?: string;
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
  // Keyed by spanId. Allows children to inherit paths even when the parent
  // is a NonRecordingSpan (remote context) with no attributes — which is
  // what OpenInference produces for LangGraph-instrumented node spans.
  private readonly _idsPathBySpanId = new Map<string, string[]>();
  private readonly _namePathBySpanId = new Map<string, string[]>();
  // Keyed by spanId. Stores the full ancestor chain start times INCLUDING self.
  // Used to emit starts_path on children (ancestors only), mirroring ids_path behavior.
  // Unlike ids_path, this must store self because parent may be a NonRecordingSpan
  // with no reachable startTime attribute — map-based lookup is the only path to root.
  private readonly _startsPathBySpanId = new Map<string, string[]>();

  constructor(
    inner: SpanProcessor, // ← WIDENED
    opts: TraceRootSpanProcessorOptions = {},
  ) {
    this.inner = inner;
    this._environment = opts.environment;
    this._gitRepo = opts.gitRepo;
    this._gitRef = opts.gitRef;
  }

  onStart(span: Span, parentContext: Context): void {
    span.setAttributes({
      'traceroot.sdk.name': SDK_NAME,
      'traceroot.sdk.version': SDK_VERSION,
    });
    if (this._environment !== undefined) {
      span.setAttribute('deployment.environment', this._environment);
    }
    if (this._gitRepo !== undefined) {
      span.setAttribute('traceroot.git.repo', this._gitRepo);
    }
    if (this._gitRef !== undefined) {
      span.setAttribute('traceroot.git.ref', this._gitRef);
    }

    // Enrich every span with its full name path from root to current span.
    // path[0] is always the root span name, so the backend can recover the
    // correct trace name even when child spans arrive before the root span.
    // Guard: a bare `{}` context (used in unit tests) has no getValue — skip gracefully.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentSpan = (
      typeof (parentContext as any)?.getValue === 'function'
        ? otelTrace.getSpan(parentContext)
        : undefined
    ) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanName = ((span as any).name as string) ?? '';

    // `span.name` and `span.parentSpanId` are not on the public @opentelemetry/api
    // Span interface but are stable internal fields on the SDK implementation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentSpanId: string | undefined =
      ((span as any).parentSpanId as string | undefined) ||
      (parentSpan?.spanContext?.()?.spanId as string | undefined);

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

    // Read startTime (OTel HrTime = [seconds, nanoseconds]). Like name and parentSpanId,
    // startTime is a stable internal SDK field not on the public @opentelemetry/api interface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanStartTime: [number, number] | undefined = (span as any).startTime as
      | [number, number]
      | undefined;

    // Encode HrTime to epoch nanoseconds as a string to avoid Number precision loss.
    // MAX_SAFE_INTEGER (~9.0e15) < current epoch-ns (~1.7e18), so arithmetic is unsafe.
    // STRING concatenation preserves all 19 digits: seconds (10 digits) + nanos (9 digits).
    let spanStartTimeNs: string = '';
    if (spanStartTime && spanStartTime.length >= 2) {
      const [seconds, nanos] = spanStartTime;
      spanStartTimeNs = `${seconds}${String(nanos).padStart(9, '0')}`;
    }

    // Fetch parent's full start chain (root→parent, INCLUDING parent's own start).
    // Prefer the map (for NonRecordingSpan parents) over span attributes.
    // CRITICAL: map and attribute values are asymmetric:
    //   - map[P] = [root_start, ..., parent_start]         (incl-self)
    //   - attribute = [root_start, ...]                     (ancestors only, excl-self)
    // If attribute fallback fires (parent ended/deleted from map), reconstruct the
    // incl-self value by appending the parent's own encoded start time.
    // If parent's startTime is not readable, treat fallback as unavailable to avoid
    // emitting a misaligned array that would break frontend index-pairing with ids_path.
    let parentStartsPath: string[] | undefined = parentSpanId
      ? this._startsPathBySpanId.get(parentSpanId)
      : undefined;
    if (!parentStartsPath && parentSpan) {
      // Validate at runtime: `attributes` is an untrusted boundary. Any instrumented
      // application can set `traceroot.span.starts_path` to any AttributeValue, and the
      // `as string[]` cast that used to sit here is erased at compile time — it checks
      // nothing. Spreading a non-iterable (number, null, object) throws a TypeError
      // inside onStart, which runs synchronously within the caller's startSpan(), so the
      // exception surfaces as a crash in application code rather than a dropped span.
      // Require a homogeneous string array so we also never propagate a value that
      // violates the emitted contract downstream.
      const rawAncestors = parentSpan.attributes?.['traceroot.span.starts_path'];
      const attributeAncestors: string[] | undefined =
        Array.isArray(rawAncestors) && rawAncestors.every((entry) => typeof entry === 'string')
          ? (rawAncestors as string[])
          : undefined;
      if (attributeAncestors !== undefined) {
        // Reconstruct full chain by appending parent's own start time
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parentStartTime: [number, number] | undefined = (parentSpan as any).startTime as
          | [number, number]
          | undefined;
        if (parentStartTime && parentStartTime.length >= 2) {
          const [parentSeconds, parentNanos] = parentStartTime;
          const parentStartTimeNs = `${parentSeconds}${String(parentNanos).padStart(9, '0')}`;
          parentStartsPath = [...attributeAncestors, parentStartTimeNs];
        }
        // If parent's startTime is not readable, treat fallback as unavailable (safer than
        // emitting a misaligned array that would pair wrong starts with wrong ancestor ids)
      }
    }

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

    // Build starts_path for emission (ancestors only, matching ids_path gating exactly).
    // Invariant: starts_path.length must equal ids_path.length. This means:
    // - If ids_path is [], emit []. If parent resolution failed and ids_path = [], emit [].
    // - If ids_path has items, emit parentStartsPath (which has len(parentIds) items).
    // We store the full chain (root→self) in the map for descendants, but emit ancestors only.
    let spanStartsPath: string[] = parentPath && parentSpanId ? parentStartsPath || [] : [];

    // EXPLICIT ALIGNMENT GUARD: defend the frontend's index-pairing assumption against
    // any future divergence between ids_path and starts_path code paths. If lengths don't
    // match, degrade to [] to prevent applying wrong starts to wrong ancestor ids.
    if (spanStartsPath.length !== spanIdsPath.length) {
      spanStartsPath = [];
    }

    span.setAttribute('traceroot.span.path', spanPath);
    span.setAttribute('traceroot.span.ids_path', spanIdsPath);
    span.setAttribute('traceroot.span.starts_path', spanStartsPath);

    // Store paths so descendant spans can inherit them via map lookup.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanId =
      typeof (span as any).spanContext === 'function' ? span.spanContext().spanId : undefined;
    if (spanId) {
      this._namePathBySpanId.set(spanId, spanPath);
      this._idsPathBySpanId.set(spanId, spanIdsPath);
      // Append this span's start time to get the full chain (root→self) for descendant lookup.
      // If start time encoding failed (unlikely), store just the ancestors so map still works.
      const fullStartsChain: string[] = spanStartTimeNs
        ? [...spanStartsPath, spanStartTimeNs]
        : spanStartsPath;
      this._startsPathBySpanId.set(spanId, fullStartsChain);
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
    this._startsPathBySpanId.delete(spanId);
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
