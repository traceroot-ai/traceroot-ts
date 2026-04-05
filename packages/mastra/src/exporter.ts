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

// OpenInference semconv keys — internal only, not exposed in public API.
const OI_SPAN_KIND = 'openinference.span.kind';
const OI_INPUT_VALUE = 'input.value';
const OI_OUTPUT_VALUE = 'output.value';
const OI_SESSION_ID = 'session.id';
const OI_USER_ID = 'user.id';

// OpenInference span kind values
type OISpanKind = 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN';

// gen_ai semconv (standard, used by multiple platforms)
const GEN_AI_SYSTEM = 'gen_ai.system';
const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
const GEN_AI_CACHE_WRITE_INPUT_TOKENS = 'gen_ai.usage.cache_creation_input_tokens';
const GEN_AI_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read_input_tokens';

// TraceRoot-specific keys
const TR_SDK_NAME = 'traceroot.sdk.name';
const TR_SDK_VERSION = 'traceroot.sdk.version';
const TR_METADATA_PREFIX = 'traceroot.metadata';

type TraceState = {
  activeSpanIds: Set<string>;
};

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
}

type ResolvedConfig = {
  endpoint: string;
  headers: Record<string, string>;
  realtime: boolean;
  disableBatch: boolean;
  batchSize: number;
  timeoutMillis: number;
};

export class TraceRootExporter extends BaseExporter {
  name = 'traceroot';

  private resolvedConfig: ResolvedConfig | null;
  private traceMap = new Map<string, TraceState>();

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

    const baseUrl = (
      config.baseUrl ?? process.env['TRACEROOT_HOST_URL'] ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');

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
    const state = this.getOrCreateTraceState(span.traceId);
    state.activeSpanIds.add(span.id);
  }

  private async handleSpanEnded(span: AnyExportedSpan): Promise<void> {
    if (!this.resolvedConfig) return;

    await this.setupIfNeeded();
    if (!this.processor) return;

    const state = this.getOrCreateTraceState(span.traceId);

    try {
      const otelSpan = this.convertToOtelSpan(span);
      this.processor.onEnd(otelSpan);

      if (this.resolvedConfig.realtime) {
        await this.processor.forceFlush();
      }
    } catch (error) {
      this.logger.error('[TraceRootExporter] Failed to export span', {
        error,
        spanId: span.id,
        traceId: span.traceId,
      });
    } finally {
      state.activeSpanIds.delete(span.id);
      if (state.activeSpanIds.size === 0) {
        this.traceMap.delete(span.traceId);
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

  private convertToOtelSpan(span: AnyExportedSpan): ReadableSpan {
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
      attributes: buildTraceRootAttributes(span),
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
    const created: TraceState = { activeSpanIds: new Set() };
    this.traceMap.set(traceId, created);
    return created;
  }

  private async setupIfNeeded(): Promise<void> {
    if (this.isSetup || !this.resolvedConfig) return;

    this.otlpExporter = new OTLPTraceExporter({
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
      this.logger.error('[TraceRootExporter] Error flushing spans', { error });
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.processor?.shutdown();
    } finally {
      this.traceMap.clear();
      await super.shutdown();
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute building — OpenInference mapping is internal to this function
// ---------------------------------------------------------------------------

function buildTraceRootAttributes(span: AnyExportedSpan): Attributes {
  const attrs: Attributes = {};

  // SDK identity (always present)
  attrs[TR_SDK_NAME] = SDK_NAME;
  attrs[TR_SDK_VERSION] = SDK_VERSION;

  // Span kind → openinference.span.kind (drives icons in TraceRoot UI)
  attrs[OI_SPAN_KIND] = mapToOISpanKind(span.type);

  // Input / output
  if (span.input !== undefined) {
    attrs[OI_INPUT_VALUE] = serialize(extractInput(span));
  }
  if (span.output !== undefined) {
    attrs[OI_OUTPUT_VALUE] = serialize(span.output);
  }

  // Session / user identity
  const sessionId = span.metadata?.sessionId;
  if (typeof sessionId === 'string' && sessionId) {
    attrs[OI_SESSION_ID] = sessionId;
  }

  const userId = span.metadata?.userId;
  if (typeof userId === 'string' && userId) {
    attrs[OI_USER_ID] = userId;
  }

  // Remaining metadata as traceroot.metadata.* (excludes sessionId/userId)
  if (span.metadata) {
    for (const [key, value] of Object.entries(span.metadata)) {
      if (key === 'sessionId' || key === 'userId' || value == null) continue;
      const v = toAttributeValue(value);
      if (v !== undefined) attrs[`${TR_METADATA_PREFIX}.${key}`] = v;
    }
  }

  // LLM-specific attributes (only for MODEL_GENERATION spans)
  if (span.type === SpanType.MODEL_GENERATION) {
    const modelAttrs = (span.attributes ?? {}) as ModelGenerationAttributes;
    if (modelAttrs.provider) attrs[GEN_AI_SYSTEM] = normalizeProvider(modelAttrs.provider);
    if (modelAttrs.model) attrs[GEN_AI_REQUEST_MODEL] = modelAttrs.model;
    if (modelAttrs.responseModel) attrs[GEN_AI_RESPONSE_MODEL] = modelAttrs.responseModel;
    Object.assign(attrs, buildUsageAttributes(modelAttrs.usage));
  }

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
  if (usage.inputTokens !== undefined) out[GEN_AI_USAGE_INPUT_TOKENS] = usage.inputTokens;
  if (usage.outputTokens !== undefined) out[GEN_AI_USAGE_OUTPUT_TOKENS] = usage.outputTokens;
  if (usage.inputDetails?.cacheWrite !== undefined) {
    out[GEN_AI_CACHE_WRITE_INPUT_TOKENS] = usage.inputDetails.cacheWrite;
  }
  if (usage.inputDetails?.cacheRead !== undefined) {
    out[GEN_AI_CACHE_READ_INPUT_TOKENS] = usage.inputDetails.cacheRead;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return '[unserializable]'; }
}

function toAttributeValue(value: unknown): Attributes[string] | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const isHomogeneous =
      value.every(v => typeof v === 'string') ||
      value.every(v => typeof v === 'number') ||
      value.every(v => typeof v === 'boolean');
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
