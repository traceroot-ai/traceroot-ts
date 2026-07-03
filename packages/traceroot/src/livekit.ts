import type { AttributeValue } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

const OI_SPAN_KIND = 'openinference.span.kind';
const INPUT_VALUE = 'input.value';
const OUTPUT_VALUE = 'output.value';
const LLM_MODEL_NAME = 'llm.model_name';
const LLM_TOKEN_COUNT_PROMPT = 'llm.token_count.prompt';
const LLM_TOKEN_COUNT_COMPLETION = 'llm.token_count.completion';
const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';

const AGENT_SPANS = new Set(['agent_turn']);
const LLM_SPANS = new Set(['llm_request']);
const TOOL_SPANS = new Set(['function_tool']);
const KNOWN_LIVEKIT_SPANS = new Set([
  ...AGENT_SPANS,
  ...LLM_SPANS,
  ...TOOL_SPANS,
  'agent_session',
  'llm_node',
  'tts_node',
  'tts_request',
  'user_turn',
]);
const LIVEKIT_SCOPE_NAME = 'livekit-agents';
const INPUT_KEYS = [
  'lk.input_text',
  'lk.user_transcript',
  'lk.chat_ctx',
  'lk.user_input',
  'lk.function_tool.arguments',
];
const OUTPUT_KEYS = ['lk.function_tool.output', 'lk.response.text'];

type SpanLike = {
  name?: string;
  attributes?: Record<string, unknown>;
  instrumentationScope?: { name?: string };
  instrumentation_scope?: { name?: string };
  instrumentationLibrary?: { name?: string };
};

export type LiveKitAttributeOverlay = Record<string, AttributeValue>;

type LiveKitAgentsModule = {
  telemetry?: {
    setTracerProvider?: (provider: NodeTracerProvider) => void;
    set_tracer_provider?: (provider: NodeTracerProvider) => void;
  };
  setTracerProvider?: (provider: NodeTracerProvider) => void;
  set_tracer_provider?: (provider: NodeTracerProvider) => void;
};

function spanName(span: ReadableSpan): string {
  return ((span as { name?: string }).name ?? '') || '';
}

function attrs(span: ReadableSpan): Record<string, unknown> {
  return ((span as SpanLike).attributes ?? {}) as Record<string, unknown>;
}

function scopeName(span: ReadableSpan): string | undefined {
  const candidate = span as SpanLike;
  return (
    candidate.instrumentationScope?.name ??
    candidate.instrumentation_scope?.name ??
    candidate.instrumentationLibrary?.name
  );
}

function first(attributes: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = attributes[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function isLiveKitSpan(span: ReadableSpan): boolean {
  const attributes = attrs(span);
  if (scopeName(span) === LIVEKIT_SCOPE_NAME) return true;
  if (KNOWN_LIVEKIT_SPANS.has(spanName(span))) return true;
  return Object.keys(attributes).some((key) => key.startsWith('lk.'));
}

function spanKind(name: string): string | undefined {
  if (AGENT_SPANS.has(name)) return 'AGENT';
  if (LLM_SPANS.has(name)) return 'LLM';
  if (TOOL_SPANS.has(name)) return 'TOOL';
  return undefined;
}

function setOverlay(overlay: LiveKitAttributeOverlay, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  overlay[key] = value as AttributeValue;
}

export function getLiveKitAttributeOverlay(span: ReadableSpan): LiveKitAttributeOverlay {
  const overlay: LiveKitAttributeOverlay = {};
  if (!isLiveKitSpan(span)) return overlay;

  const name = spanName(span);
  const attributes = attrs(span);

  setOverlay(overlay, OI_SPAN_KIND, spanKind(name));
  setOverlay(overlay, INPUT_VALUE, first(attributes, INPUT_KEYS));
  setOverlay(overlay, OUTPUT_VALUE, first(attributes, OUTPUT_KEYS));

  if (LLM_SPANS.has(name)) {
    setOverlay(overlay, LLM_MODEL_NAME, attributes['gen_ai.request.model']);
    setOverlay(overlay, LLM_TOKEN_COUNT_PROMPT, attributes['gen_ai.usage.input_tokens']);
    setOverlay(overlay, LLM_TOKEN_COUNT_COMPLETION, attributes['gen_ai.usage.output_tokens']);
  }

  setOverlay(overlay, GEN_AI_TOOL_NAME, attributes['lk.function_tool.name']);
  return overlay;
}

export function wireLiveKitInstrumentation(
  livekitAgents: unknown,
  provider?: NodeTracerProvider,
): void {
  if (!provider) return;

  const candidate = livekitAgents as LiveKitAgentsModule;
  const setTracerProvider =
    candidate.telemetry?.setTracerProvider ??
    candidate.telemetry?.set_tracer_provider ??
    candidate.setTracerProvider ??
    candidate.set_tracer_provider;

  if (typeof setTracerProvider !== 'function') {
    throw new Error(
      '[TraceRoot] Failed to instrument LiveKit Agents: expected a telemetry.setTracerProvider function.',
    );
  }

  setTracerProvider(provider);
}
