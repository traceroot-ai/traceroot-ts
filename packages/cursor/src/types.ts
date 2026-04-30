import type { SDKMessage, InteractionUpdate, RunStatus } from '@cursor/sdk';

export const ERROR_MESSAGE_PREVIEW_MAX = 256;
export const TOOL_RESULT_PREVIEW_MAX = 512;
export const ASSISTANT_TEXT_PREVIEW_MAX = 256;

export const ATTR = {
  AGENT_ID: 'cursor.agent_id',
  RUN_ID: 'cursor.run_id',
  MODEL_ID: 'cursor.model_id',
  RUNTIME: 'cursor.runtime',
  SESSION_ID: 'cursor.session_id',
  USER_ID: 'cursor.user_id',
  TERMINAL_STATUS: 'cursor.terminal_status',
  USAGE_INPUT: 'cursor.usage.input_tokens',
  USAGE_OUTPUT: 'cursor.usage.output_tokens',
  USAGE_CACHE_READ: 'cursor.usage.cache_read_tokens',
  USAGE_CACHE_WRITE: 'cursor.usage.cache_write_tokens',
  DURATION_MS: 'cursor.duration_ms',
  ERROR_CLASS: 'error.class',
  ERROR_MESSAGE_PREVIEW: 'error.message_preview',
  TOOL_CALL_ID: 'cursor.tool.call_id',
  TOOL_TYPE: 'cursor.tool.type',
  TOOL_RESULT_STATUS: 'cursor.tool.result_status',
  TOOL_RESULT_PREVIEW: 'cursor.tool.result_preview',
  TOOL_ARGS_TRUNCATED: 'cursor.tool.args_truncated',
  TOOL_RESULT_TRUNCATED: 'cursor.tool.result_truncated',
  TOOL_TERMINATED_BY_CANCEL: 'cursor.tool.terminated_by_cancel',

  OI_INPUT_VALUE: 'input.value',
  OI_OUTPUT_VALUE: 'output.value',
  OI_SESSION_ID: 'session.id',
  OI_USER_ID: 'user.id',
  OI_MODEL_NAME: 'llm.model_name',
  OI_TOKEN_PROMPT: 'llm.token_count.prompt',
  OI_TOKEN_COMPLETION: 'llm.token_count.completion',
  OI_TOKEN_TOTAL: 'llm.token_count.total',
  OI_SPAN_KIND: 'openinference.span.kind',
} as const;

export const OI_KIND = {
  AGENT: 'AGENT',
  TOOL: 'TOOL',
  LLM: 'LLM',
  CHAIN: 'CHAIN',
} as const;

export const INPUT_PREVIEW_MAX = 8000;
export const OUTPUT_PREVIEW_MAX = 16000;

export const SPAN = {
  RUN: 'cursor.run',
  TOOL_PREFIX: 'cursor.tool.',
} as const;

export const EVENT = {
  ASSISTANT_TEXT: 'assistant.text',
  THINKING: 'thinking',
  UNKNOWN: 'cursor.unknown_event',
} as const;

export type Runtime = 'local' | 'cloud';

export type TerminalStatus = 'finished' | 'cancelled' | 'error';

export type ToolCloseStatus = 'ok' | 'error' | 'cancelled';

export type SpanTarget = 'run' | 'tool';

export interface MapperContext {
  agentId: string;
  runId?: string;
}

export type SpanOp =
  | {
      readonly kind: 'OpenRunSpan';
      readonly agentId: string;
      readonly modelId?: string;
      readonly runtime: Runtime;
    }
  | {
      readonly kind: 'SetRunAttrs';
      readonly attrs: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'OpenToolSpan';
      readonly callId: string;
      readonly toolType: string;
    }
  | {
      readonly kind: 'EnrichToolSpan';
      readonly callId: string;
      readonly attrs: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'CloseToolSpan';
      readonly callId: string;
      readonly status?: ToolCloseStatus;
    }
  | {
      readonly kind: 'AddSpanEvent';
      readonly target: SpanTarget;
      readonly callId?: string;
      readonly name: string;
      readonly attrs: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'CloseRunSpan';
      readonly terminalStatus: TerminalStatus;
    };

export interface AdapterOptions {
  sessionId?: string;
  userId?: string;
  captureBodies?: boolean;
  runtime?: Runtime;
}

export type { SDKMessage, InteractionUpdate, RunStatus };
