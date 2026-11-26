// src/google-genai.ts — instrumentation for Google's @google/genai SDK, for which there
// is no OpenInference instrumentation to reuse.
//
// Every generate call (plain, streamed, chat, and each round of automatic function
// calling) goes through two methods of the exported `Models` class,
// generateContentInternal and generateContentStreamInternal. Patching those gives one
// LLM span per API request. The public generateContent is assigned per instance in the
// constructor, so there is nothing on the prototype to patch for it.
import { context, diag, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { isTracingSuppressed } from '@opentelemetry/core';
import { OITracer, safelyJSONStringify } from '@arizeai/openinference-core';
import {
  LLMProvider,
  LLMSystem,
  MimeType,
  OpenInferenceSpanKind,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';

const TRACER_NAME = '@traceroot-ai/google-genai';

// Symbol.for(), so two loaded copies of this package see each other's patch.
const WRAPPED = Symbol.for('traceroot.google-genai.wrapped');

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name?: string; response?: unknown };
}

interface Content {
  role?: string;
  parts?: Part[];
}

interface GenerateParams {
  model?: string;
  contents?: unknown;
  config?: Record<string, unknown>;
}

interface UsageMetadata {
  promptTokenCount?: number;
  toolUsePromptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

interface GenerateResponse {
  candidates?: { content?: Content; finishReason?: string; index?: number }[];
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
  promptFeedback?: unknown;
  sdkHttpResponse?: unknown;
}

type Generate = (this: GoogleGenAIModels, params: GenerateParams) => Promise<unknown>;

interface GoogleGenAIModels {
  apiClient?: { isVertexAI?: () => boolean };
  generateContentInternal?: Generate;
  generateContentStreamInternal?: Generate;
  [WRAPPED]?: boolean;
}

type Attributes = Record<string, string | number>;

// Request settings that are not model parameters: sent separately (system prompt,
// tools) or transport options that may carry credentials in headers.
const NON_PARAMETER_KEYS = new Set(['systemInstruction', 'tools', 'httpOptions', 'abortSignal']);

// Resolved per span: shutdown() swaps the global provider, so a held tracer goes stale.
// OITracer adds the session/user context attributes and applies OPENINFERENCE_HIDE_*.
function tracer(): OITracer {
  return new OITracer({ tracer: trace.getTracer(TRACER_NAME) });
}

/** Inline file bytes are large base64 that nothing reads back: keep only their size. */
function withoutInlineData(key: string, value: unknown): unknown {
  if (key === 'inlineData' && value && typeof value === 'object') {
    const { data, ...rest } = value as { data?: unknown };
    return typeof data === 'string' ? { ...rest, data: `[${data.length} base64 chars]` } : value;
  }
  return value;
}

function json(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, withoutInlineData);
  } catch {
    return safelyJSONStringify(value) ?? undefined;
  }
}

function isPart(value: unknown): value is Part {
  return typeof value === 'object' && value !== null && !('parts' in value) && !('role' in value);
}

/**
 * The SDK accepts a string, a part, a content, or an array of any of those. Loose
 * strings and parts next to each other belong to one user turn.
 */
function toContents(input: unknown): Content[] {
  if (input === undefined || input === null) return [];
  const items = Array.isArray(input) ? input : [input];
  const contents: Content[] = [];
  let loose: Content | undefined;
  for (const item of items) {
    const part = typeof item === 'string' ? { text: item } : isPart(item) ? item : undefined;
    if (part) {
      if (!loose) {
        loose = { role: 'user', parts: [] };
        contents.push(loose);
      }
      loose.parts!.push(part);
    } else {
      loose = undefined;
      contents.push(item as Content);
    }
  }
  return contents;
}

function setMessage(attributes: Attributes, prefix: string, role: string, parts: Part[]): void {
  attributes[`${prefix}.${SemanticConventions.MESSAGE_ROLE}`] = role;
  const text = parts
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (text) attributes[`${prefix}.${SemanticConventions.MESSAGE_CONTENT}`] = text;

  let calls = 0;
  for (const { functionCall } of parts) {
    if (!functionCall) continue;
    const call = `${prefix}.${SemanticConventions.MESSAGE_TOOL_CALLS}.${calls++}`;
    if (functionCall.id) {
      attributes[`${call}.${SemanticConventions.TOOL_CALL_ID}`] = functionCall.id;
    }
    if (functionCall.name) {
      attributes[`${call}.${SemanticConventions.TOOL_CALL_FUNCTION_NAME}`] = functionCall.name;
    }
    const args = json(functionCall.args ?? {});
    if (args !== undefined) {
      attributes[`${call}.${SemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`] = args;
    }
  }
}

function inputMessageAttributes(params: GenerateParams): Attributes {
  const attributes: Attributes = {};
  let index = 0;
  const add = (role: string, parts: Part[]) => {
    setMessage(attributes, `${SemanticConventions.LLM_INPUT_MESSAGES}.${index++}`, role, parts);
  };

  const system = toContents(params.config?.['systemInstruction']).flatMap((c) => c.parts ?? []);
  if (system.length > 0) add('system', system);

  for (const content of toContents(params.contents)) {
    const parts = content.parts ?? [];
    const results = parts.filter((part) => part.functionResponse);
    // Each tool result is its own message; whatever else the turn holds stays together.
    for (const { functionResponse } of results) {
      const prefix = `${SemanticConventions.LLM_INPUT_MESSAGES}.${index}`;
      add('tool', [{ text: json(functionResponse!.response) }]);
      if (functionResponse!.name) {
        attributes[`${prefix}.${SemanticConventions.MESSAGE_NAME}`] = functionResponse!.name;
      }
      if (functionResponse!.id) {
        attributes[`${prefix}.${SemanticConventions.MESSAGE_TOOL_CALL_ID}`] = functionResponse!.id;
      }
    }
    const rest = parts.filter((part) => !part.functionResponse);
    if (rest.length > 0) {
      add(content.role === 'model' ? 'assistant' : (content.role ?? 'user'), rest);
    }
  }
  return attributes;
}

function requestAttributes(params: GenerateParams, vertex: boolean): Attributes {
  const attributes: Attributes = {
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
    [SemanticConventions.LLM_PROVIDER]: LLMProvider.GOOGLE,
    ...inputMessageAttributes(params),
  };
  if (vertex) attributes[SemanticConventions.LLM_SYSTEM] = LLMSystem.VERTEXAI;
  if (params.model) attributes[SemanticConventions.LLM_MODEL_NAME] = params.model;

  const { httpOptions: _http, abortSignal: _signal, ...config } = params.config ?? {};
  const input = json({ model: params.model, contents: params.contents, config });
  if (input !== undefined) {
    attributes[SemanticConventions.INPUT_VALUE] = input;
    attributes[SemanticConventions.INPUT_MIME_TYPE] = MimeType.JSON;
  }

  const parameters = Object.fromEntries(
    Object.entries(config).filter(([key]) => !NON_PARAMETER_KEYS.has(key)),
  );
  if (Object.keys(parameters).length > 0) {
    const serialized = json(parameters);
    if (serialized !== undefined) {
      attributes[SemanticConventions.LLM_INVOCATION_PARAMETERS] = serialized;
    }
  }

  const tools = (params.config?.['tools'] ?? []) as { functionDeclarations?: unknown[] }[];
  tools
    .flatMap((tool) => tool?.functionDeclarations ?? [])
    .forEach((declaration, index) => {
      const schema = json(declaration);
      if (schema !== undefined) {
        attributes[
          `${SemanticConventions.LLM_TOOLS}.${index}.${SemanticConventions.TOOL_JSON_SCHEMA}`
        ] = schema;
      }
    });
  return attributes;
}

function usageAttributes(usage: UsageMetadata): Attributes {
  const attributes: Attributes = {};
  const set = (key: string, value: number | undefined) => {
    if (typeof value === 'number') attributes[key] = value;
  };
  const sum = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

  // Gemini reports tool-result and thinking tokens beside the prompt and candidate
  // counts; both are billed, as input and output respectively.
  set(
    SemanticConventions.LLM_TOKEN_COUNT_PROMPT,
    sum(usage.promptTokenCount, usage.toolUsePromptTokenCount),
  );
  set(
    SemanticConventions.LLM_TOKEN_COUNT_COMPLETION,
    sum(usage.candidatesTokenCount, usage.thoughtsTokenCount),
  );
  set(SemanticConventions.LLM_TOKEN_COUNT_TOTAL, usage.totalTokenCount);
  set(SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ, usage.cachedContentTokenCount);
  set(SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING, usage.thoughtsTokenCount);
  return attributes;
}

function responseAttributes(response: GenerateResponse): Attributes {
  const attributes: Attributes = {};
  if (response.modelVersion) {
    attributes[SemanticConventions.LLM_MODEL_NAME] = response.modelVersion;
  }
  (response.candidates ?? []).forEach((candidate, index) => {
    setMessage(
      attributes,
      `${SemanticConventions.LLM_OUTPUT_MESSAGES}.${index}`,
      'assistant',
      candidate.content?.parts ?? [],
    );
  });
  const { sdkHttpResponse: _http, ...body } = response;
  const output = json(body);
  if (output !== undefined) {
    attributes[SemanticConventions.OUTPUT_VALUE] = output;
    attributes[SemanticConventions.OUTPUT_MIME_TYPE] = MimeType.JSON;
  }
  if (response.usageMetadata) Object.assign(attributes, usageAttributes(response.usageMetadata));
  return attributes;
}

/** Folds streamed chunks into the response the same request would have returned whole. */
function mergeChunk(total: GenerateResponse, chunk: GenerateResponse): void {
  // Later chunks repeat the usage with running counts, so the last one wins.
  if (chunk.usageMetadata) total.usageMetadata = chunk.usageMetadata;
  if (chunk.modelVersion) total.modelVersion = chunk.modelVersion;
  if (chunk.promptFeedback) total.promptFeedback = chunk.promptFeedback;
  for (const candidate of chunk.candidates ?? []) {
    const candidates = (total.candidates ??= []);
    const index = candidate.index ?? 0;
    const merged = (candidates[index] ??= { index, content: { role: 'model', parts: [] } });
    if (candidate.finishReason) merged.finishReason = candidate.finishReason;
    const parts = (merged.content!.parts ??= []);
    for (const part of candidate.content?.parts ?? []) {
      const last = parts[parts.length - 1];
      if (
        typeof part.text === 'string' &&
        typeof last?.text === 'string' &&
        !part.thought === !last.thought
      ) {
        last.text += part.text;
      } else {
        parts.push({ ...part });
      }
    }
  }
}

/** Telemetry must never fail the model call it describes. */
function record(span: Span, build: () => Attributes): void {
  try {
    span.setAttributes(build());
  } catch (err) {
    diag.warn('[traceroot] failed to record a Gemini call', err);
  }
}

function fail(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : String(error);
  span.recordException(exception);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  span.end();
}

function succeed(span: Span): void {
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

async function* tracedStream(
  span: Span,
  stream: AsyncIterable<GenerateResponse>,
): AsyncGenerator<GenerateResponse> {
  const total: GenerateResponse = {};
  let failed = false;
  try {
    for await (const chunk of stream) {
      try {
        mergeChunk(total, chunk);
      } catch (err) {
        diag.warn('[traceroot] failed to read a Gemini stream chunk', err);
      }
      yield chunk;
    }
  } catch (error) {
    failed = true;
    record(span, () => responseAttributes(total));
    fail(span, error);
    throw error;
  } finally {
    // Also reached when the consumer stops early: what arrived is still recorded.
    if (!failed) {
      record(span, () => responseAttributes(total));
      succeed(span);
    }
  }
}

function wrap(original: Generate, spanName: string, streaming: boolean): Generate {
  return async function (this: GoogleGenAIModels, params: GenerateParams) {
    if (isTracingSuppressed(context.active())) return original.call(this, params);

    const span = tracer().startSpan(spanName);
    record(span, () => requestAttributes(params, this.apiClient?.isVertexAI?.() === true));
    let result: unknown;
    try {
      result = await context.with(trace.setSpan(context.active(), span), () =>
        original.call(this, params),
      );
    } catch (error) {
      fail(span, error);
      throw error;
    }
    if (streaming) return tracedStream(span, result as AsyncIterable<GenerateResponse>);
    record(span, () => responseAttributes(result as GenerateResponse));
    succeed(span);
    return result;
  };
}

/**
 * Patch `@google/genai` so each model request is traced as an LLM span.
 *
 * @param moduleRef `import * as genai from '@google/genai'`.
 * @returns Whether the module is instrumented.
 */
export function instrumentGoogleGenAI(moduleRef: unknown): boolean {
  const module = moduleRef as {
    Models?: { prototype?: GoogleGenAIModels };
    default?: { Models?: { prototype?: GoogleGenAIModels } };
  };
  const prototype = (module?.Models ?? module?.default?.Models)?.prototype;
  const generate = prototype?.generateContentInternal;
  const stream = prototype?.generateContentStreamInternal;
  if (!prototype || typeof generate !== 'function' || typeof stream !== 'function') {
    console.warn(
      '[traceroot] instrumentModules.googleGenAI was not instrumented. Pass the module ' +
        "namespace (`import * as genai from '@google/genai'`), not the GoogleGenAI class.",
    );
    return false;
  }
  if (prototype[WRAPPED]) return true;
  prototype.generateContentInternal = wrap(generate, 'Google GenAI Generate Content', false);
  prototype.generateContentStreamInternal = wrap(
    stream,
    'Google GenAI Generate Content Stream',
    true,
  );
  prototype[WRAPPED] = true;
  return true;
}
