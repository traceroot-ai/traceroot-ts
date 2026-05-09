import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';

const SPAN_KIND_ATTR = 'openinference.span.kind';
const INPUT_VALUE_ATTR = 'input.value';
const INPUT_MIME_ATTR = 'input.mime_type';
const OUTPUT_VALUE_ATTR = 'output.value';
const OUTPUT_MIME_ATTR = 'output.mime_type';
const MODEL_NAME_ATTR = 'llm.model_name';
const PROVIDER_ATTR = 'llm.provider';
const SYSTEM_ATTR = 'llm.system';
const PROMPT_TOKENS_ATTR = 'llm.token_count.prompt';
const COMPLETION_TOKENS_ATTR = 'llm.token_count.completion';
const TOTAL_TOKENS_ATTR = 'llm.token_count.total';
const FINISH_REASONS_ATTR = 'llm.response.finish_reasons';
const INVOCATION_PARAMS_ATTR = 'llm.invocation_parameters';

const PROVIDER = 'mistralai';
const TRACER_NAME = 'traceroot-mistral-instrumentation';

type MistralModuleLike = {
  Mistral?: { prototype?: Record<string, unknown> };
  default?: { prototype?: Record<string, unknown> };
};

type ChatCompletionRequest = {
  model?: string;
  messages?: unknown;
  // Other request fields are captured wholesale into invocation_parameters
  // (model + messages stripped out for clarity).
  [key: string]: unknown;
};

type ToolCall = {
  id?: string;
  function?: { name?: string; arguments?: unknown };
};

type AssistantMessage = {
  role?: string;
  content?: unknown;
  toolCalls?: ToolCall[] | null;
};

type ChatCompletionResponse = {
  model?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  choices?: Array<{
    index?: number;
    message?: AssistantMessage;
    finishReason?: string;
  }>;
};

type ChatLike = {
  complete?: (...args: unknown[]) => Promise<unknown>;
  constructor?: { prototype?: Record<string, unknown> };
};

const PATCH_MARKER = Symbol.for('@traceroot-ai/mistral-instrumentation/patched');

interface PrototypeWithMarker extends Record<string, unknown> {
  [PATCH_MARKER]?: boolean;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toStringContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (
          item &&
          typeof item === 'object' &&
          'type' in item &&
          'text' in item &&
          (item as { type?: string }).type === 'text'
        ) {
          return String((item as { text: unknown }).text);
        }
        return '';
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (content == null) return undefined;
  return String(content);
}

function extractInputValue(req: ChatCompletionRequest | undefined): string | undefined {
  if (!req?.messages || !Array.isArray(req.messages) || req.messages.length === 0) {
    return undefined;
  }

  const userMessages = req.messages
    .filter(
      (m): m is { role?: unknown; content?: unknown } =>
        Boolean(m) && typeof m === 'object' && 'role' in m,
    )
    .filter((m) => m.role === 'user')
    .map((m) => toStringContent(m.content))
    .filter((v): v is string => Boolean(v));

  if (userMessages.length > 0) {
    return userMessages.join('\n');
  }

  return safeJson(req.messages);
}

function extractOutputValue(response: ChatCompletionResponse | undefined): string | undefined {
  const message = response?.choices?.[0]?.message;
  if (!message) return undefined;

  const text = toStringContent(message.content);
  if (text) return text;

  // No textual content but tool calls were emitted — surface those as the output.
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    return safeJson(
      message.toolCalls.map((tc) => ({
        id: tc?.id,
        name: tc?.function?.name,
        arguments: tc?.function?.arguments,
      })),
    );
  }

  return undefined;
}

/**
 * OpenInference-compatible instrumentor for `@mistralai/mistralai` (v2.x).
 *
 * Patches `Chat.prototype.complete` indirectly by overriding the lazy `chat`
 * getter on `Mistral.prototype`. On first access, the returned `Chat` instance
 * is inspected to obtain its constructor prototype; `complete` is wrapped via
 * `_wrap()`, the original getter is restored, and subsequent `mistral.chat`
 * accesses use the (cached) Chat with the patched method available through the
 * prototype chain.
 *
 * Captured attributes follow OpenInference chat-completion semantic conventions:
 *
 * - `openinference.span.kind` = "LLM"
 * - `llm.system` / `llm.provider` = "mistralai"
 * - `llm.model_name`
 * - `llm.token_count.prompt` / `.completion` / `.total`
 * - `llm.invocation_parameters` (request body minus model/messages)
 * - `llm.response.finish_reasons`
 * - `input.value` / `input.mime_type`
 * - `output.value` / `output.mime_type`
 *
 * The Mistral SDK is ESM-only, so the RITM module hook in `init()` will not
 * fire for ESM consumers — they should pass the module ref via
 * `instrumentModules: { mistral: import * as MistralSdk from "@mistralai/mistralai" }`,
 * which routes through `manuallyInstrument()`.
 */
export class MistralInstrumentation extends InstrumentationBase {
  private patchedChatPrototype: PrototypeWithMarker | null = null;

  constructor() {
    super('@traceroot-ai/traceroot-mistral-instrumentation', '0.1.0');
  }

  init() {
    return [
      new InstrumentationNodeModuleDefinition<MistralModuleLike>(
        '@mistralai/mistralai',
        ['*'],
        (moduleExports) => this.patch(moduleExports ?? {}),
        (moduleExports) => this.unpatch(moduleExports ?? {}),
      ),
    ];
  }

  manuallyInstrument(moduleExports: unknown): void {
    this.patch(moduleExports as MistralModuleLike);
  }

  private patch(moduleExports: MistralModuleLike): MistralModuleLike {
    const MistralCtor = moduleExports?.Mistral ?? moduleExports?.default;
    const proto = MistralCtor?.prototype as Record<string, unknown> | undefined;
    if (!proto) {
      return moduleExports;
    }

    const chatDescriptor = Object.getOwnPropertyDescriptor(proto, 'chat');
    if (!chatDescriptor || typeof chatDescriptor.get !== 'function') {
      return moduleExports;
    }
    const originalGetter = chatDescriptor.get;

    // Capture instance methods in a closure so the property getter below
    // doesn't need to alias `this` (its `this` is the Mistral instance).
    const wrapChatComplete = (chatProto: PrototypeWithMarker): void => {
      this._wrap(chatProto, 'complete', (original) => this.makeWrappedComplete(original));
      chatProto[PATCH_MARKER] = true;
      this.patchedChatPrototype = chatProto;
    };

    Object.defineProperty(proto, 'chat', {
      configurable: true,
      enumerable: chatDescriptor.enumerable ?? false,
      get(this: unknown) {
        const chat = originalGetter.call(this) as ChatLike | undefined;
        if (chat && typeof chat.complete === 'function') {
          const chatProto = chat.constructor?.prototype as PrototypeWithMarker | undefined;
          if (
            chatProto &&
            !chatProto[PATCH_MARKER] &&
            typeof chatProto['complete'] === 'function'
          ) {
            wrapChatComplete(chatProto);
            // Restore the original getter — the patched `complete` is now on
            // the Chat prototype, so further accesses don't need interception.
            Object.defineProperty(proto, 'chat', chatDescriptor);
          }
        }
        return chat;
      },
    });

    return moduleExports;
  }

  private unpatch(moduleExports: MistralModuleLike): MistralModuleLike {
    if (this.patchedChatPrototype) {
      this._unwrap(this.patchedChatPrototype, 'complete');
      delete this.patchedChatPrototype[PATCH_MARKER];
      this.patchedChatPrototype = null;
    }
    return moduleExports;
  }

  private makeWrappedComplete(
    original: unknown,
  ): (this: unknown, ...args: unknown[]) => Promise<unknown> {
    const originalComplete = original as (...args: unknown[]) => Promise<unknown>;
    return function wrappedComplete(this: unknown, ...args: unknown[]): Promise<unknown> {
      const request = args[0] as ChatCompletionRequest | undefined;
      const model = request?.model ?? 'unknown';
      const spanName = `mistral.chat.complete ${model}`;

      return trace.getTracer(TRACER_NAME).startActiveSpan(spanName, async (span) => {
        span.setAttribute(SPAN_KIND_ATTR, 'LLM');
        span.setAttribute(SYSTEM_ATTR, PROVIDER);
        span.setAttribute(PROVIDER_ATTR, PROVIDER);
        if (request?.model) span.setAttribute(MODEL_NAME_ATTR, request.model);

        const inputValue = extractInputValue(request);
        if (inputValue) {
          span.setAttribute(INPUT_VALUE_ATTR, inputValue);
          span.setAttribute(INPUT_MIME_ATTR, 'text/plain');
        }

        if (request) {
          // Strip messages (already captured as input.value) and model (own
          // attribute) — the rest characterises the call (tools, temperature,
          // toolChoice, parallelToolCalls, ...).
          const { messages: _messages, model: _model, ...invocationParams } = request;
          if (Object.keys(invocationParams).length > 0) {
            span.setAttribute(INVOCATION_PARAMS_ATTR, safeJson(invocationParams));
          }
        }

        try {
          const response = (await originalComplete.apply(this, args)) as ChatCompletionResponse;

          const responseModel = response?.model;
          if (responseModel) span.setAttribute(MODEL_NAME_ATTR, responseModel);

          const promptTokens = response?.usage?.promptTokens;
          if (typeof promptTokens === 'number') {
            span.setAttribute(PROMPT_TOKENS_ATTR, promptTokens);
          }
          const completionTokens = response?.usage?.completionTokens;
          if (typeof completionTokens === 'number') {
            span.setAttribute(COMPLETION_TOKENS_ATTR, completionTokens);
          }
          const totalTokens = response?.usage?.totalTokens;
          if (typeof totalTokens === 'number') {
            span.setAttribute(TOTAL_TOKENS_ATTR, totalTokens);
          }

          const finishReason = response?.choices?.[0]?.finishReason;
          if (finishReason) {
            span.setAttribute(FINISH_REASONS_ATTR, [finishReason]);
          }

          const outputValue = extractOutputValue(response);
          if (outputValue) {
            span.setAttribute(OUTPUT_VALUE_ATTR, outputValue);
            span.setAttribute(OUTPUT_MIME_ATTR, 'text/plain');
          }

          return response as unknown;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
          throw error;
        } finally {
          span.end();
        }
      });
    };
  }
}
