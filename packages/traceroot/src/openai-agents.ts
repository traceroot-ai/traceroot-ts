import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Span as OTelSpan } from '@opentelemetry/api';
import type { SpanData } from '@openai/agents';
import {
  AGENT_NAME,
  OI_INPUT_VALUE,
  OI_LLM_MODEL_NAME,
  OI_LLM_TOKEN_COUNT_COMPLETION,
  OI_LLM_TOKEN_COUNT_PROMPT,
  OI_OUTPUT_VALUE,
  OI_SPAN_KIND,
  SPAN_METADATA,
  TOOL_NAME,
} from './constants';

// Structural mirrors of the public read-surface of @openai/agents `Span` and `Trace`.
// We can't use the SDK class types directly because they hold their state in
// ECMAScript `#private` fields, which makes plain object fixtures (used in tests)
// unassignable to them. The runtime objects we receive from the SDK satisfy these
// shapes via public getters.
export interface OpenAIAgentsSpan {
  type: 'trace.span';
  spanId: string;
  traceId: string;
  parentId?: string | null;
  spanData: SpanData;
  startedAt?: string | null;
  endedAt?: string | null;
  error?: { message: string } | null;
}

export interface OpenAIAgentsTrace {
  type?: 'trace';
  traceId: string;
  name?: string;
}

const SPAN_KIND: Record<SpanData['type'], string> = {
  agent: 'AGENT',
  function: 'TOOL',
  generation: 'LLM',
  response: 'LLM',
  handoff: 'AGENT',
  custom: 'CHAIN',
  guardrail: 'CHAIN',
  transcription: 'LLM',
  speech: 'LLM',
  speech_group: 'CHAIN',
  mcp_tools: 'TOOL',
};

export function getSpanName(data: SpanData): string {
  switch (data.type) {
    case 'agent':
      return data.name;
    case 'function':
      return data.name;
    case 'generation':
      return data.model ? `generation [${data.model}]` : 'generation';
    case 'response':
      return 'response';
    case 'handoff':
      return data.to_agent ? `handoff -> ${data.to_agent}` : 'handoff';
    case 'custom':
      return data.name;
    case 'guardrail':
      return data.name;
    case 'transcription':
      return 'transcription';
    case 'speech':
      return 'speech';
    case 'speech_group':
      return 'speech_group';
    case 'mcp_tools':
      return data.server ? `mcp_tools [${data.server}]` : 'mcp_tools';
  }
}

export function getSpanAttributes(data: SpanData): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    [OI_SPAN_KIND]: SPAN_KIND[data.type],
  };
  switch (data.type) {
    case 'agent':
      attrs[AGENT_NAME] = data.name;
      if (data.tools?.length) attrs[OI_INPUT_VALUE] = JSON.stringify({ tools: data.tools });
      break;
    case 'function':
      attrs[TOOL_NAME] = data.name;
      if (data.input != null) attrs[OI_INPUT_VALUE] = data.input;
      if (data.output != null) attrs[OI_OUTPUT_VALUE] = data.output;
      break;
    case 'generation':
      if (data.model) attrs[OI_LLM_MODEL_NAME] = data.model;
      if (data.input != null) attrs[OI_INPUT_VALUE] = JSON.stringify(data.input);
      if (data.output != null) attrs[OI_OUTPUT_VALUE] = JSON.stringify(data.output);
      if (data.usage?.input_tokens != null)
        attrs[OI_LLM_TOKEN_COUNT_PROMPT] = data.usage.input_tokens;
      if (data.usage?.output_tokens != null)
        attrs[OI_LLM_TOKEN_COUNT_COMPLETION] = data.usage.output_tokens;
      break;
    case 'response': {
      const r = data._response as Record<string, unknown> | undefined;
      if (r?.model) attrs[OI_LLM_MODEL_NAME] = r.model as string;
      const usage = r?.usage as Record<string, number> | undefined;
      if (usage?.input_tokens != null) attrs[OI_LLM_TOKEN_COUNT_PROMPT] = usage.input_tokens;
      if (usage?.output_tokens != null) attrs[OI_LLM_TOKEN_COUNT_COMPLETION] = usage.output_tokens;
      if (data._input != null)
        attrs[OI_INPUT_VALUE] =
          typeof data._input === 'string' ? data._input : JSON.stringify(data._input);
      if (r?.output != null) attrs[OI_OUTPUT_VALUE] = JSON.stringify(r.output);
      break;
    }
    case 'handoff':
      if (data.from_agent) attrs[AGENT_NAME] = data.from_agent;
      if (data.to_agent) attrs[SPAN_METADATA] = JSON.stringify({ to_agent: data.to_agent });
      break;
    case 'custom':
      if (data.data) attrs[OI_INPUT_VALUE] = JSON.stringify(data.data);
      break;
    case 'guardrail':
      attrs[SPAN_METADATA] = JSON.stringify({ triggered: data.triggered });
      break;
    case 'transcription':
      if (data.model) attrs[OI_LLM_MODEL_NAME] = data.model;
      if (data.output) attrs[OI_OUTPUT_VALUE] = data.output;
      break;
    case 'speech':
      if (data.model) attrs[OI_LLM_MODEL_NAME] = data.model;
      if (data.input) attrs[OI_INPUT_VALUE] = data.input;
      break;
    case 'speech_group':
      if (data.input) attrs[OI_INPUT_VALUE] = data.input;
      break;
    case 'mcp_tools':
      if (data.server) attrs[TOOL_NAME] = data.server;
      if (data.result) attrs[OI_OUTPUT_VALUE] = JSON.stringify(data.result);
      break;
  }
  return attrs;
}

export class OpenAIAgentsProcessor {
  private readonly spanMap = new Map<string, OTelSpan>();
  private readonly ctxMap = new Map<string, Context>();
  private readonly tracer = trace.getTracer('@traceroot-ai/openai-agents');

  async onTraceStart(t: OpenAIAgentsTrace): Promise<void> {
    const span = this.tracer.startSpan(t.name ?? 'Agent workflow', {
      attributes: { [OI_SPAN_KIND]: 'CHAIN' },
    });
    this.spanMap.set(t.traceId, span);
    this.ctxMap.set(t.traceId, trace.setSpan(context.active(), span));
  }

  async onTraceEnd(t: OpenAIAgentsTrace): Promise<void> {
    this.spanMap.get(t.traceId)?.end();
    this.spanMap.delete(t.traceId);
    this.ctxMap.delete(t.traceId);
  }

  async onSpanStart(s: OpenAIAgentsSpan): Promise<void> {
    const parentCtx =
      (s.parentId != null && this.ctxMap.get(s.parentId)) ||
      this.ctxMap.get(s.traceId) ||
      context.active();
    const otelSpan = this.tracer.startSpan(
      getSpanName(s.spanData),
      { startTime: s.startedAt ? new Date(s.startedAt) : undefined },
      parentCtx,
    );
    this.spanMap.set(s.spanId, otelSpan);
    this.ctxMap.set(s.spanId, trace.setSpan(parentCtx, otelSpan));
  }

  async onSpanEnd(s: OpenAIAgentsSpan): Promise<void> {
    const otelSpan = this.spanMap.get(s.spanId);
    if (otelSpan) {
      const attrs = getSpanAttributes(s.spanData);
      for (const [k, v] of Object.entries(attrs)) otelSpan.setAttribute(k, v);
      if (s.error) otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: s.error.message });
      otelSpan.end(s.endedAt ? new Date(s.endedAt) : undefined);
    }
    this.spanMap.delete(s.spanId);
    this.ctxMap.delete(s.spanId);
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

/**
 * Replaces @openai/agents' default tracing processors with TraceRoot's.
 *
 * The SDK's umbrella package eagerly registers an OpenAI-hosted exporter at
 * import time (sends spans to api.openai.com). Calling `setTraceProcessors`
 * here replaces that default — spans go to TraceRoot only.
 *
 * To dual-export (e.g. ship to both TraceRoot *and* OpenAI), call
 * `addTraceProcessor(otherProcessor)` from `@openai/agents` after `initialize()`.
 */
export function wireOpenAIAgentsProcessor(mod: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setTraceProcessors = (mod as any)?.setTraceProcessors;
  if (typeof setTraceProcessors !== 'function') {
    throw new Error(
      '[TraceRoot] instrumentModules.openaiAgents does not expose setTraceProcessors. ' +
        'Pass `import * as agents from "@openai/agents"` (the module namespace, not a sub-export).',
    );
  }
  setTraceProcessors([new OpenAIAgentsProcessor()]);
}
