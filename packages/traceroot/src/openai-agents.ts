import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Span as OTelSpan } from '@opentelemetry/api';

// Minimal type mirrors for @openai/agents shapes — no runtime import needed.
export type OASpanData =
  | { type: 'agent'; name: string; tools?: string[]; handoffs?: string[]; output_type?: string }
  | { type: 'function'; name: string; input: string; output: string; mcp_data?: string }
  | {
      type: 'generation';
      model?: string;
      input?: unknown[];
      output?: unknown[];
      usage?: { input_tokens?: number; output_tokens?: number };
    }
  | { type: 'response'; response_id?: string; _input?: unknown; _response?: unknown }
  | { type: 'handoff'; from_agent?: string; to_agent?: string }
  | { type: 'custom'; name: string; data: Record<string, unknown> }
  | { type: 'guardrail'; name: string; triggered: boolean }
  | { type: 'transcription'; input?: unknown; output?: string; model?: string }
  | { type: 'speech'; input?: string; output?: unknown; model?: string }
  | { type: 'speech_group'; input?: string }
  | { type: 'mcp_tools'; server?: string; result?: string[] };

export interface OATrace {
  type: 'trace';
  traceId: string;
  name?: string; // optional — SDK may omit it
}

export interface OASpan {
  type: 'trace.span';
  spanId: string;
  traceId: string;
  parentId?: string | null;
  spanData: OASpanData;
  startedAt?: string | null;
  endedAt?: string | null;
  error?: { message: string } | null;
}

const SPAN_KIND: Record<OASpanData['type'], string> = {
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

export function getSpanName(data: OASpanData): string {
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

export function getSpanAttributes(data: OASpanData): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    'openinference.span.kind': SPAN_KIND[data.type],
  };
  switch (data.type) {
    case 'agent':
      attrs['agent.name'] = data.name;
      if (data.tools?.length) attrs['input.value'] = JSON.stringify({ tools: data.tools });
      break;
    case 'function':
      attrs['tool.name'] = data.name;
      if (data.input != null) attrs['input.value'] = data.input;
      if (data.output != null) attrs['output.value'] = data.output;
      break;
    case 'generation':
      if (data.model) attrs['llm.model_name'] = data.model;
      if (data.input != null) attrs['input.value'] = JSON.stringify(data.input);
      if (data.output != null) attrs['output.value'] = JSON.stringify(data.output);
      if (data.usage?.input_tokens != null)
        attrs['llm.token_count.prompt'] = data.usage.input_tokens;
      if (data.usage?.output_tokens != null)
        attrs['llm.token_count.completion'] = data.usage.output_tokens;
      break;
    case 'response': {
      const r = data._response as Record<string, unknown> | undefined;
      if (r?.model) attrs['llm.model_name'] = r.model as string;
      const usage = r?.usage as Record<string, number> | undefined;
      if (usage?.input_tokens != null) attrs['llm.token_count.prompt'] = usage.input_tokens;
      if (usage?.output_tokens != null) attrs['llm.token_count.completion'] = usage.output_tokens;
      if (data._input != null)
        attrs['input.value'] =
          typeof data._input === 'string' ? data._input : JSON.stringify(data._input);
      if (r?.output != null) attrs['output.value'] = JSON.stringify(r.output);
      break;
    }
    case 'handoff':
      if (data.from_agent) attrs['agent.name'] = data.from_agent;
      if (data.to_agent)
        attrs['traceroot.span.metadata'] = JSON.stringify({ to_agent: data.to_agent });
      break;
    case 'custom':
      if (data.data) attrs['input.value'] = JSON.stringify(data.data);
      break;
    case 'guardrail':
      attrs['traceroot.span.metadata'] = JSON.stringify({ triggered: data.triggered });
      break;
    case 'transcription':
      if (data.model) attrs['llm.model_name'] = data.model;
      if (data.output) attrs['output.value'] = data.output;
      break;
    case 'speech':
      if (data.model) attrs['llm.model_name'] = data.model;
      if (data.input) attrs['input.value'] = data.input;
      break;
    case 'speech_group':
      if (data.input) attrs['input.value'] = data.input;
      break;
    case 'mcp_tools':
      if (data.server) attrs['tool.name'] = data.server;
      if (data.result) attrs['output.value'] = JSON.stringify(data.result);
      break;
  }
  return attrs;
}

export class TraceRootTracingProcessor {
  private static readonly MAX_SPANS = 2000;
  private readonly spanMap = new Map<string, OTelSpan>();
  private readonly ctxMap = new Map<string, Context>();
  private get tracer() {
    return trace.getTracer('@traceroot-ai/openai-agents');
  }

  async onTraceStart(t: OATrace): Promise<void> {
    if (this.spanMap.size >= TraceRootTracingProcessor.MAX_SPANS) return;
    const span = this.tracer.startSpan(t.name ?? 'Agent workflow', {
      attributes: { 'openinference.span.kind': 'CHAIN' },
    });
    this.spanMap.set(t.traceId, span);
    this.ctxMap.set(t.traceId, trace.setSpan(context.active(), span));
  }

  async onTraceEnd(t: OATrace): Promise<void> {
    this.spanMap.get(t.traceId)?.end();
    this.spanMap.delete(t.traceId);
    this.ctxMap.delete(t.traceId);
  }

  async onSpanStart(s: OASpan): Promise<void> {
    if (this.spanMap.size >= TraceRootTracingProcessor.MAX_SPANS) return;
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

  async onSpanEnd(s: OASpan): Promise<void> {
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

export function wireOpenAIAgentsProcessor(mod: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = (mod as any).getGlobalTraceProvider?.();
  if (!provider) {
    throw new Error(
      '[TraceRoot] instrumentModules.openaiAgents does not expose getGlobalTraceProvider. Check your @openai/agents version (>=0.0.1 required).',
    );
  }
  if (typeof provider.registerProcessor !== 'function') {
    throw new Error(
      '[TraceRoot] provider.registerProcessor is not a function. Check your @openai/agents version (>=0.0.1 required).',
    );
  }
  provider.registerProcessor(new TraceRootTracingProcessor());
}
