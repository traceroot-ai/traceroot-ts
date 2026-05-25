/**
 * TraceRootExporter for Mastra Observability
 *
 * Sends Mastra tracing events to TraceRoot via OTLP/HTTP (protobuf).
 * OpenInference semantic conventions are used internally — they are not
 * part of the public API.
 */

import type {
  AnyExportedSpan,
  InitExporterOptions,
  ModelGenerationAttributes,
  TracingEvent,
  UsageStats,
} from '@mastra/core/observability';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';
import type { BaseExporterConfig } from '@mastra/observability';
import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import type { Attributes, HrTime, Link, SpanContext, SpanStatus } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace-base';
import type { InstrumentationLibrary } from '@opentelemetry/core';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_SDK_LANGUAGE,
  ATTR_TELEMETRY_SDK_NAME,
  ATTR_TELEMETRY_SDK_VERSION,
} from '@opentelemetry/semantic-conventions';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: SDK_VERSION } = require('../package.json') as { version: string };
const SDK_NAME = 'traceroot-mastra';

const DEFAULT_BASE_URL = 'https://app.traceroot.ai';

const TR_ATTRIBUTES = {
  // Span path keys must match TraceRootSpanProcessor (packages/traceroot/src/processor.ts).
  SPAN_PATH: 'traceroot.span.path',
  SPAN_IDS_PATH: 'traceroot.span.ids_path',
  SDK_NAME: 'traceroot.sdk.name',
  SDK_VERSION: 'traceroot.sdk.version',
  METADATA_PREFIX: 'traceroot.metadata',
} as const;

// OpenInference semconv keys — internal only, not exposed in public API.
const OI_ATTRIBUTES = {
  SPAN_KIND: 'openinference.span.kind',
  INPUT_VALUE: 'input.value',
  OUTPUT_VALUE: 'output.value',
  SESSION_ID: 'session.id',
  USER_ID: 'user.id',
} as const;

// OpenInference span kind values
type OISpanKind = 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN';

// gen_ai semconv (standard, used by multiple platforms)
const GEN_AI_ATTRIBUTES = {
  SYSTEM: 'gen_ai.system',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  CACHE_WRITE_INPUT_TOKENS: 'gen_ai.usage.cache_creation_input_tokens',
  CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read_input_tokens',
} as const;

type TraceState = {
  activeSpanIds: Set<string>;
  // Every span (live or completed) seen for this trace. Lets us clean up the
  // ancestry maps when a trace is TTL-evicted because some SPAN_ENDED never
  // arrived.
  knownSpanIds: Set<string>;
  // Wall-clock ms of the last event touching this trace. Drives TTL eviction
  // for traces that never receive a closing SPAN_ENDED.
  lastTouched: number;
};

// Traces whose lastTouched is older than this are evicted on the next sweep.
// Bounds memory under "SPAN_ENDED never delivered" conditions (process crash
// mid-span upstream, dropped event, integration bug).
const STALE_TRACE_TTL_MS = 5 * 60 * 1000;
// Skip the eviction sweep entirely if traceMap is small — saves the linear
// walk for the common case where everything is closing normally.
const SWEEP_THRESHOLD = 64;

// Alias so we can swap between SDK versions easily
type InstrumentationScope = InstrumentationLibrary;

export interface TraceRootExporterConfig extends BaseExporterConfig {
  /**
   * TraceRoot API key. Defaults to `process.env.TRACEROOT_API_KEY`.
   */
  apiKey?: string;
  /**
   * Base URL for the TraceRoot backend. Defaults to `https://app.traceroot.ai`.
   * Falls back to `process.env.TRACEROOT_HOST_URL`.
   */
  baseUrl?: string;
  /**
   * Flush after each span. Useful for scripts / short-lived processes.
   */
  realtime?: boolean;
  /**
   * Disable batching (uses SimpleSpanProcessor). Useful for tests.
   */
  disableBatch?: boolean;
  /**
   * Max spans to export per batch.
   */
  batchSize?: number;
  /**
   * OTLP export timeout in milliseconds.
   */
  timeoutMillis?: number;
  /**
   * Override the leaf SpanExporter. When set, skips OTLPTraceExporter entirely.
   * Intended for testing — pass an InMemorySpanExporter to capture exported spans.
   */
  _spanExporter?: SpanExporter;
}

type ResolvedConfig = {
  endpoint: string;
  headers: Record<string, string>;
  realtime: boolean;
  disableBatch: boolean;
  batchSize: number;
  timeoutMillis: number;
  _spanExporter: SpanExporter | undefined;
};

export class TraceRootExporter extends BaseExporter {
  name = 'traceroot';

  private resolvedConfig: ResolvedConfig | null;
  private traceMap = new Map<string, TraceState>();

  // Span path ancestry maps — same two-map pattern as TraceRootSpanProcessor (PR #71).
  // Keyed by spanId; populated on SPAN_STARTED, consumed on SPAN_ENDED, deleted after export.
  private _namePathBySpanId = new Map<string, string[]>();
  private _idsPathBySpanId = new Map<string, string[]>();

  private resource?: Resource;
  private scope?: InstrumentationScope;
  private processor?: BatchSpanProcessor | SimpleSpanProcessor;
  private otlpExporter?: SpanExporter;
  private isSetup = false;

  constructor(config: TraceRootExporterConfig = {}) {
    super(config);

    const apiKey = config.apiKey ?? process.env['TRACEROOT_API_KEY'];
    if (!apiKey) {
      this.setDisabled(
        'Missing API key. Set TRACEROOT_API_KEY env var or pass apiKey to TraceRootExporter().',
      );
      this.resolvedConfig = null;
      return;
    }

    let baseUrl = config.baseUrl ?? process.env['TRACEROOT_HOST_URL'] ?? DEFAULT_BASE_URL;
    while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'x-traceroot-sdk-name': SDK_NAME,
      'x-traceroot-sdk-version': SDK_VERSION,
    };

    this.resolvedConfig = {
      endpoint: `${baseUrl}/api/v1/public/traces`,
      headers,
      realtime: config.realtime ?? false,
      disableBatch: config.disableBatch ?? false,
      batchSize: config.batchSize ?? 512,
      timeoutMillis: config.timeoutMillis ?? 30_000,
      _spanExporter: config._spanExporter,
    };
  }

  init(options: InitExporterOptions): void {
    const serviceName = options.config?.serviceName || 'mastra-service';

    this.resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: 'unknown',
      [ATTR_TELEMETRY_SDK_NAME]: SDK_NAME,
      [ATTR_TELEMETRY_SDK_VERSION]: SDK_VERSION,
      [ATTR_TELEMETRY_SDK_LANGUAGE]: 'nodejs',
    });

    this.scope = {
      name: SDK_NAME,
      version: SDK_VERSION,
    };
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type === TracingEventType.SPAN_STARTED && !event.exportedSpan.isEvent) {
      this.trackSpanStart(event.exportedSpan);
      return;
    }

    if (event.type !== TracingEventType.SPAN_ENDED) {
      return;
    }

    await this.handleSpanEnded(event.exportedSpan);
  }

  private trackSpanStart(span: AnyExportedSpan): void {
    this.sweepStaleTracesIfNeeded();
    const state = this.getOrCreateTraceState(span.traceId);
    state.activeSpanIds.add(span.id);
    state.knownSpanIds.add(span.id);
    state.lastTouched = Date.now();

    // Compute ancestry paths using the parent map — same pattern as TraceRootSpanProcessor.
    // Gate on parentNamePath (not parentSpanId) to keep path/ids_path in sync:
    // if the parent was never tracked, treat this span as a root rather than emitting
    // a path with no parent prefix but a non-empty ids_path.
    //
    // Normalize the parent ID before appending so ids_path entries match the OTLP spanIds
    // produced by convertToOtelSpan (which also runs every ID through normalizeHex).
    // Without this, a non-canonical upstream ID would break the backend's join between
    // path entries and exported span IDs.
    const parentSpanId = span.parentSpanId;
    const parentNamePath = parentSpanId ? this._namePathBySpanId.get(parentSpanId) : undefined;
    const parentIdsPath = parentSpanId ? this._idsPathBySpanId.get(parentSpanId) : undefined;

    const namePath: string[] = parentNamePath ? [...parentNamePath, span.name] : [span.name];
    const normalizedParentSpanId =
      parentNamePath && parentSpanId ? normalizeHex(parentSpanId, 16) : undefined;
    const idsPath: string[] = normalizedParentSpanId
      ? parentIdsPath
        ? [...parentIdsPath, normalizedParentSpanId]
        : [normalizedParentSpanId]
      : [];

    this._namePathBySpanId.set(span.id, namePath);
    this._idsPathBySpanId.set(span.id, idsPath);
  }

  private async handleSpanEnded(span: AnyExportedSpan): Promise<void> {
    if (!this.resolvedConfig) return;

    await this.setupIfNeeded();
    if (!this.processor) return;

    this.sweepStaleTracesIfNeeded();
    const state = this.getOrCreateTraceState(span.traceId);
    state.lastTouched = Date.now();

    // Capture paths before the finally block cleans the maps.
    const namePath = this._namePathBySpanId.get(span.id);
    const idsPath = this._idsPathBySpanId.get(span.id);

    try {
      const otelSpan = this.convertToOtelSpan(span, namePath, idsPath);
      this.processor.onEnd(otelSpan);

      if (this.resolvedConfig.realtime) {
        await this.processor.forceFlush();
      }
    } catch (error) {
      console.error('[TraceRootExporter] Failed to export span', {
        error,
        spanId: span.id,
        traceId: span.traceId,
      });
    } finally {
      state.activeSpanIds.delete(span.id);
      state.knownSpanIds.delete(span.id);
      if (state.activeSpanIds.size === 0) {
        this.traceMap.delete(span.traceId);
      }
      this._namePathBySpanId.delete(span.id);
      this._idsPathBySpanId.delete(span.id);
    }
  }

  // Periodic eviction guard: if traces accumulate beyond SWEEP_THRESHOLD and any
  // are older than STALE_TRACE_TTL_MS since their last event, drop them and
  // their associated ancestry-map entries. Cheap when traceMap is small.
  private sweepStaleTracesIfNeeded(): void {
    if (this.traceMap.size < SWEEP_THRESHOLD) return;
    const cutoff = Date.now() - STALE_TRACE_TTL_MS;
    for (const [traceId, state] of this.traceMap) {
      if (state.lastTouched < cutoff) {
        for (const orphanId of state.knownSpanIds) {
          this._namePathBySpanId.delete(orphanId);
          this._idsPathBySpanId.delete(orphanId);
        }
        this.traceMap.delete(traceId);
      }
    }
  }

  private getResource(): Resource {
    if (!this.resource) {
      this.resource = new Resource({
        [ATTR_SERVICE_NAME]: 'mastra-service',
        [ATTR_SERVICE_VERSION]: 'unknown',
        [ATTR_TELEMETRY_SDK_NAME]: SDK_NAME,
        [ATTR_TELEMETRY_SDK_VERSION]: SDK_VERSION,
        [ATTR_TELEMETRY_SDK_LANGUAGE]: 'nodejs',
      });
    }
    return this.resource;
  }

  private getScope(): InstrumentationScope {
    if (!this.scope) {
      this.scope = { name: SDK_NAME, version: SDK_VERSION };
    }
    return this.scope;
  }

  private convertToOtelSpan(
    span: AnyExportedSpan,
    namePath?: string[],
    idsPath?: string[],
  ): ReadableSpan {
    const resource = this.getResource();
    const instrumentationScope = this.getScope();

    const startTime = dateToHrTime(span.startTime);
    const endTime = span.endTime ? dateToHrTime(span.endTime) : startTime;
    const duration = computeDuration(span.startTime, span.endTime);
    const { status, events } = buildStatusAndEvents(span, startTime);

    const traceId = normalizeHex(span.traceId, 32);
    const spanId = normalizeHex(span.id, 16);

    const spanContext: SpanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };

    const parentSpanId = span.parentSpanId ? normalizeHex(span.parentSpanId, 16) : undefined;

    const links: Link[] = [];

    return {
      name: span.name,
      kind: getOtelSpanKind(span.type),
      spanContext: () => spanContext,
      parentSpanId,
      startTime,
      endTime,
      status,
      attributes: buildTraceRootAttributes(span, namePath, idsPath),
      links,
      events,
      duration,
      ended: true,
      resource,
      instrumentationLibrary: instrumentationScope,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
  }

  private getOrCreateTraceState(traceId: string): TraceState {
    const existing = this.traceMap.get(traceId);
    if (existing) return existing;
    const created: TraceState = {
      activeSpanIds: new Set(),
      knownSpanIds: new Set(),
      lastTouched: Date.now(),
    };
    this.traceMap.set(traceId, created);
    return created;
  }

  private async setupIfNeeded(): Promise<void> {
    if (this.isSetup || !this.resolvedConfig) return;

    this.otlpExporter =
      this.resolvedConfig._spanExporter ??
      new OTLPTraceExporter({
        url: this.resolvedConfig.endpoint,
        headers: this.resolvedConfig.headers,
        timeoutMillis: this.resolvedConfig.timeoutMillis,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compression: 'gzip' as any,
      });

    this.processor = this.resolvedConfig.disableBatch
      ? new SimpleSpanProcessor(this.otlpExporter)
      : new BatchSpanProcessor(this.otlpExporter, {
          maxExportBatchSize: this.resolvedConfig.batchSize,
          exportTimeoutMillis: this.resolvedConfig.timeoutMillis,
        });

    this.isSetup = true;
  }

  async flush(): Promise<void> {
    if (this.isDisabled || !this.processor) return;
    try {
      await this.processor.forceFlush();
    } catch (error) {
      console.error('[TraceRootExporter] Error flushing spans', { error });
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.processor?.shutdown();
    } finally {
      this.traceMap.clear();
      this._namePathBySpanId.clear();
      this._idsPathBySpanId.clear();
      await super.shutdown();
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute building — OpenInference mapping is internal to this function
// ---------------------------------------------------------------------------

function buildTraceRootAttributes(
  span: AnyExportedSpan,
  namePath?: string[],
  idsPath?: string[],
): Attributes {
  const attrs: Attributes = {};

  // SDK identity (always present)
  attrs[TR_ATTRIBUTES.SDK_NAME] = SDK_NAME;
  attrs[TR_ATTRIBUTES.SDK_VERSION] = SDK_VERSION;

  // Span kind → openinference.span.kind (drives icons in TraceRoot UI)
  attrs[OI_ATTRIBUTES.SPAN_KIND] = mapToOISpanKind(span.type);

  // Input / output
  if (span.input !== undefined) {
    attrs[OI_ATTRIBUTES.INPUT_VALUE] = serialize(extractInput(span));
  }
  if (span.output !== undefined) {
    attrs[OI_ATTRIBUTES.OUTPUT_VALUE] = serialize(span.output);
  }

  // Session / user identity
  const sessionId = span.metadata?.sessionId;
  if (typeof sessionId === 'string' && sessionId) {
    attrs[OI_ATTRIBUTES.SESSION_ID] = sessionId;
  }

  const userId = span.metadata?.userId;
  if (typeof userId === 'string' && userId) {
    attrs[OI_ATTRIBUTES.USER_ID] = userId;
  }

  // Remaining metadata as traceroot.metadata.* (excludes sessionId/userId)
  if (span.metadata) {
    for (const [key, value] of Object.entries(span.metadata)) {
      if (key === 'sessionId' || key === 'userId' || value == null) continue;
      const v = toAttributeValue(value);
      if (v !== undefined) attrs[`${TR_ATTRIBUTES.METADATA_PREFIX}.${key}`] = v;
    }
  }

  // LLM-specific attributes (only for MODEL_GENERATION spans)
  if (span.type === SpanType.MODEL_GENERATION) {
    const modelAttrs = (span.attributes ?? {}) as ModelGenerationAttributes;
    if (modelAttrs.provider)
      attrs[GEN_AI_ATTRIBUTES.SYSTEM] = normalizeProvider(modelAttrs.provider);
    if (modelAttrs.model) attrs[GEN_AI_ATTRIBUTES.REQUEST_MODEL] = modelAttrs.model;
    if (modelAttrs.responseModel)
      attrs[GEN_AI_ATTRIBUTES.RESPONSE_MODEL] = modelAttrs.responseModel;
    Object.assign(attrs, buildUsageAttributes(modelAttrs.usage));
  }

  // Live tracing — span ancestry for real-time UI streaming.
  // Mirrors the Map-based path propagation in TraceRootSpanProcessor (PR #71).
  if (namePath !== undefined) attrs[TR_ATTRIBUTES.SPAN_PATH] = namePath;
  if (idsPath !== undefined) attrs[TR_ATTRIBUTES.SPAN_IDS_PATH] = idsPath;

  return attrs;
}

function mapToOISpanKind(type: SpanType): OISpanKind {
  switch (type) {
    case SpanType.MODEL_GENERATION:
    case SpanType.MODEL_STEP:
    case SpanType.MODEL_CHUNK:
      return 'LLM';
    case SpanType.TOOL_CALL:
    case SpanType.MCP_TOOL_CALL:
      return 'TOOL';
    default:
      // Mastra emits AGENT_RUN and other agent-level span types.
      // Map anything with "agent" in the name to AGENT, rest to CHAIN.
      return String(type).toLowerCase().includes('agent') ? 'AGENT' : 'CHAIN';
  }
}

function getOtelSpanKind(type: SpanType): SpanKind {
  switch (type) {
    case SpanType.MODEL_GENERATION:
    case SpanType.MCP_TOOL_CALL:
      return SpanKind.CLIENT;
    default:
      return SpanKind.INTERNAL;
  }
}

function extractInput(span: AnyExportedSpan): unknown {
  // For MODEL_GENERATION, surface the messages array if present (enables chat view in UI)
  if (span.type !== SpanType.MODEL_GENERATION) return span.input;
  const input = span.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const msgs = (input as { messages?: unknown }).messages;
  return Array.isArray(msgs) ? msgs : input;
}

function buildUsageAttributes(usage?: UsageStats): Attributes {
  if (!usage) return {};
  const out: Attributes = {};
  if (usage.inputTokens !== undefined)
    out[GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS] = usage.inputTokens;
  if (usage.outputTokens !== undefined)
    out[GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS] = usage.outputTokens;
  if (usage.inputDetails?.cacheWrite !== undefined) {
    out[GEN_AI_ATTRIBUTES.CACHE_WRITE_INPUT_TOKENS] = usage.inputDetails.cacheWrite;
  }
  if (usage.inputDetails?.cacheRead !== undefined) {
    out[GEN_AI_ATTRIBUTES.CACHE_READ_INPUT_TOKENS] = usage.inputDetails.cacheRead;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function toAttributeValue(value: unknown): Attributes[string] | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value)) {
    const isHomogeneous =
      value.every((v) => typeof v === 'string') ||
      value.every((v) => typeof v === 'number') ||
      value.every((v) => typeof v === 'boolean');
    if (isHomogeneous) return value as Attributes[string];
  }
  return serialize(value);
}

function dateToHrTime(date: Date): HrTime {
  const ms = date.getTime();
  return [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];
}

function computeDuration(start: Date, end?: Date): HrTime {
  if (!end) return [0, 0];
  const diff = end.getTime() - start.getTime();
  return [Math.floor(diff / 1000), (diff % 1000) * 1_000_000];
}

function buildStatusAndEvents(
  span: AnyExportedSpan,
  defaultTime: HrTime,
): { status: SpanStatus; events: TimedEvent[] } {
  if (!span.errorInfo) {
    return { status: { code: SpanStatusCode.OK }, events: [] };
  }

  const events: TimedEvent[] = [
    {
      name: 'exception',
      attributes: {
        'exception.message': span.errorInfo.message,
        'exception.type': 'Error',
        ...(span.errorInfo.details?.stack
          ? { 'exception.stacktrace': span.errorInfo.details.stack as string }
          : {}),
      },
      time: defaultTime,
      droppedAttributesCount: 0,
    },
  ];

  return {
    status: { code: SpanStatusCode.ERROR, message: span.errorInfo.message },
    events,
  };
}

function normalizeHex(id: string, targetLen: number): string {
  let s = id.toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  return s.padStart(targetLen, '0').slice(-targetLen);
}

function normalizeProvider(provider: string): string {
  return provider.split('.').shift()?.toLowerCase().trim() ?? provider.toLowerCase().trim();
}
