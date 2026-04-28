import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';

const SPAN_KIND_ATTR = 'openinference.span.kind';
const INPUT_VALUE_ATTR = 'input.value';
const OUTPUT_VALUE_ATTR = 'output.value';
const MODEL_NAME_ATTR = 'llm.model_name';
const PROMPT_TOKENS_ATTR = 'llm.token_count.prompt';
const COMPLETION_TOKENS_ATTR = 'llm.token_count.completion';

type GroqModuleLike = {
  Groq?: { prototype?: Record<string, unknown> };
  default?: { prototype?: Record<string, unknown> };
};

type ChatRequestBody = {
  model?: string;
  messages?: unknown;
};

type CompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

type ChatCompletionResponse = {
  model?: string;
  usage?: CompletionUsage;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

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

function extractInputValue(body: ChatRequestBody | undefined): string | undefined {
  if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0)
    return undefined;

  const userMessages = body.messages
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

  return safeJson(body.messages);
}

function extractOutputValue(response: ChatCompletionResponse | undefined): string | undefined {
  const content = response?.choices?.[0]?.message?.content;
  return toStringContent(content);
}

export class GroqInstrumentation extends InstrumentationBase {
  private patchedPrototype: Record<string, unknown> | null = null;

  constructor() {
    super('@traceroot-ai/traceroot-groq-instrumentation', '0.1.0');
  }

  init() {
    return [
      new InstrumentationNodeModuleDefinition<GroqModuleLike>(
        'groq-sdk',
        ['*'],
        (moduleExports) => this.patch(moduleExports ?? {}),
        (moduleExports) => this.unpatch(moduleExports ?? {}),
        [
          new InstrumentationNodeModuleFile<GroqModuleLike>(
            'client.js',
            ['*'],
            (moduleExports) => this.patch(moduleExports ?? {}),
            (moduleExports) => this.unpatch(moduleExports ?? {}),
          ),
        ],
      ),
    ];
  }

  manuallyInstrument(moduleExports: unknown): void {
    this.patch(moduleExports as GroqModuleLike);
  }

  private patch(moduleExports: GroqModuleLike): GroqModuleLike {
    const GroqCtor = moduleExports?.Groq ?? moduleExports?.default;
    const proto = GroqCtor?.prototype;
    if (!proto || typeof proto['post'] !== 'function') {
      return moduleExports;
    }
    if (this.patchedPrototype === proto) {
      return moduleExports;
    }

    this._wrap(proto, 'post', (original) => {
      const originalPost = original as (...args: unknown[]) => Promise<unknown>;
      return function wrappedPost(this: unknown, ...args: unknown[]): Promise<unknown> {
        const path = args[0];
        const opts = args[1] as { body?: ChatRequestBody } | undefined;

        if (path !== '/openai/v1/chat/completions') {
          return originalPost.apply(this, args);
        }

        return trace
          .getTracer('traceroot-groq-instrumentation')
          .startActiveSpan('groq.chat.completions.create', async (span) => {
            span.setAttribute(SPAN_KIND_ATTR, 'LLM');

            const model = opts?.body?.model;
            if (model) span.setAttribute(MODEL_NAME_ATTR, model);

            const inputValue = extractInputValue(opts?.body);
            if (inputValue) span.setAttribute(INPUT_VALUE_ATTR, inputValue);

            try {
              const response = (await originalPost.apply(this, args)) as ChatCompletionResponse;

              const responseModel = response?.model;
              if (responseModel) span.setAttribute(MODEL_NAME_ATTR, responseModel);

              const promptTokens = response?.usage?.prompt_tokens;
              if (typeof promptTokens === 'number') {
                span.setAttribute(PROMPT_TOKENS_ATTR, promptTokens);
              }

              const completionTokens = response?.usage?.completion_tokens;
              if (typeof completionTokens === 'number') {
                span.setAttribute(COMPLETION_TOKENS_ATTR, completionTokens);
              }

              const outputValue = extractOutputValue(response);
              if (outputValue) span.setAttribute(OUTPUT_VALUE_ATTR, outputValue);

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
    });

    this.patchedPrototype = proto;
    return moduleExports;
  }

  private unpatch(moduleExports: GroqModuleLike): GroqModuleLike {
    const GroqCtor = moduleExports?.Groq ?? moduleExports?.default;
    const proto = GroqCtor?.prototype;
    if (!proto || typeof proto['post'] !== 'function') {
      return moduleExports;
    }
    this._unwrap(proto, 'post');
    if (this.patchedPrototype === proto) {
      this.patchedPrototype = null;
    }
    return moduleExports;
  }
}
