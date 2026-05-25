import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Span as OTelSpan } from '@opentelemetry/api';
import {
  OI_INPUT_VALUE,
  OI_LLM_MODEL_NAME,
  OI_LLM_TOKEN_COUNT_COMPLETION,
  OI_LLM_TOKEN_COUNT_PROMPT,
  OI_OUTPUT_VALUE,
  OI_SPAN_KIND,
  OI_TRACE_SESSION_ID,
  TOOL_NAME,
} from './constants';

type ClaudeAgentSDKMessage = {
  type?: string;
  subtype?: string;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
    model?: string;
    usage?: ClaudeUsage;
  };
  parent_tool_use_id?: string | null;
  result?: string;
  usage?: ClaudeUsage;
  num_turns?: number;
  session_id?: string;
  total_cost_usd?: number;
  [key: string]: unknown;
};

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type ClaudeAgentSDKQueryParams = {
  prompt?: string | AsyncIterable<ClaudeAgentSDKMessage>;
  options?: ClaudeAgentSDKQueryOptions;
};

type ClaudeAgentSDKQueryOptions = {
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
};

type HookMatcher = {
  matcher?: string;
  hooks: HookCallback[];
};

type HookCallback = (
  input: Record<string, unknown>,
  toolUseId?: string,
  options?: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

type ClaudeAgentSDKModule = {
  query?: (params: ClaudeAgentSDKQueryParams) => AsyncIterable<ClaudeAgentSDKMessage>;
  [key: string]: unknown;
};

type ToolState = {
  ctx: Context;
  hasSubagent: boolean;
  name: string;
  span: OTelSpan;
  toolUseId: string;
};

type SubagentState = {
  agentId?: string;
  ctx: Context;
  ended?: boolean;
  span: OTelSpan;
  toolUseId: string;
};

type ActiveLLMSpanState = {
  ctx: Context;
  span: OTelSpan;
};

type QueryState = {
  accumulatedOutputTokens: number;
  activeLLMSpansByParent: Map<string, ActiveLLMSpanState>;
  agentIdToToolUseId: Map<string, string>;
  currentMessageStartTime: Date;
  currentMessageId?: string;
  ctx: Context;
  params: ClaudeAgentSDKQueryParams;
  pendingAssistantMessages: ClaudeAgentSDKMessage[];
  querySpan: OTelSpan;
  rawSubagentToolUseIdToToolUseId: Map<string, string>;
  subagents: Map<string, SubagentState>;
  toolUseToParent: Map<string, string | null>;
  tools: Map<string, ToolState>;
  tracer: ReturnType<typeof trace.getTracer>;
};

// Use the global symbol registry so duplicated package copies still avoid double wrapping.
const WRAPPED = Symbol.for('traceroot.claude_agent_sdk.wrapped');
const ROOT_LLM_PARENT_KEY = '__root__';
const LLM_SPAN_NAME = 'anthropic.messages.create';
const QUERY_SPAN_NAME = 'ClaudeAgent.query';

const OI_SPAN_KIND_VALUE = {
  AGENT: 'AGENT',
  LLM: 'LLM',
  TOOL: 'TOOL',
} as const;

const LLM_TOKEN_ATTRIBUTES = {
  TOTAL: 'llm.token_count.total',
  CACHE_READ: 'llm.token_count.prompt_details.cache_read',
  CACHE_CREATION: 'llm.token_count.prompt_details.cache_creation',
} as const;

const GEN_AI_ATTRIBUTES = {
  RESPONSE_MODEL: 'gen_ai.response.model',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_NAME: 'gen_ai.tool.name',
} as const;

const CLAUDE_AGENT_ATTRIBUTES = {
  AGENT_ID: 'claude_agent_sdk.agent_id',
  AGENT_TYPE: 'claude_agent_sdk.agent_type',
  CWD: 'claude_agent_sdk.cwd',
  DURATION_MS: 'claude_agent_sdk.duration_ms',
  MODEL: 'claude_agent_sdk.model',
  NUM_TURNS: 'claude_agent_sdk.num_turns',
  TOOL_USE_COUNT: 'claude_agent_sdk.tool_use_count',
  TOOL_USE_ID: 'claude_agent_sdk.tool_use_id',
  TOTAL_COST_USD: 'claude_agent_sdk.total_cost_usd',
} as const;

function tryStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function setJsonAttribute(span: OTelSpan, key: string, value: unknown): void {
  const serialized = tryStringify(value);
  if (serialized !== undefined) span.setAttribute(key, serialized);
}

function getToolUseId(input: Record<string, unknown>, toolUseId?: string): string | undefined {
  return toolUseId ?? (typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined);
}

function getString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

function getUsage(message: ClaudeAgentSDKMessage): ClaudeUsage | undefined {
  return message.message?.usage ?? message.usage;
}

function setUsageAttributes(span: OTelSpan, usage: ClaudeUsage | undefined): void {
  if (!usage) return;

  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const prompt = (usage.input_tokens ?? 0) + cacheRead + cacheCreation;
  const completion = usage.output_tokens ?? 0;

  if (prompt > 0) span.setAttribute(OI_LLM_TOKEN_COUNT_PROMPT, prompt);
  if (completion > 0) span.setAttribute(OI_LLM_TOKEN_COUNT_COMPLETION, completion);
  if (prompt > 0 || completion > 0) {
    span.setAttribute(LLM_TOKEN_ATTRIBUTES.TOTAL, prompt + completion);
  }
  if (cacheRead > 0) {
    span.setAttribute(LLM_TOKEN_ATTRIBUTES.CACHE_READ, cacheRead);
  }
  if (cacheCreation > 0) {
    span.setAttribute(LLM_TOKEN_ATTRIBUTES.CACHE_CREATION, cacheCreation);
  }
}

function setCommonModel(span: OTelSpan, model: string | undefined): void {
  if (!model) return;
  span.setAttribute(OI_LLM_MODEL_NAME, model);
  span.setAttribute(GEN_AI_ATTRIBUTES.RESPONSE_MODEL, model);
}

function getMessageModel(
  message: ClaudeAgentSDKMessage,
  options: ClaudeAgentSDKQueryOptions | undefined,
): string | undefined {
  return message.message?.model ?? options?.model;
}

function llmParentKey(parentToolUseId: string | null | undefined): string {
  return parentToolUseId ?? ROOT_LLM_PARENT_KEY;
}

function isTaskSiblingTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task' || toolName === 'Bash';
}

function getParentToolUseIdForTool(
  state: QueryState,
  toolUseId: string,
  input: Record<string, unknown>,
): string | null {
  if (state.toolUseToParent.has(toolUseId)) {
    return state.toolUseToParent.get(toolUseId) ?? null;
  }

  const agentId = getString(input, 'agent_id');
  if (!agentId) return null;
  return state.agentIdToToolUseId.get(agentId) ?? null;
}

function getToolParentContext(state: QueryState, input: Record<string, unknown>): Context {
  const agentId = getString(input, 'agent_id');
  const subagentToolUseId = agentId ? state.agentIdToToolUseId.get(agentId) : undefined;
  const subagent = subagentToolUseId ? state.subagents.get(subagentToolUseId) : undefined;
  return subagent?.ctx ?? state.ctx;
}

function getTaskParentContext(
  state: QueryState,
  parentToolUseId: string | null | undefined,
): Context {
  if (parentToolUseId) {
    return state.subagents.get(parentToolUseId)?.ctx ?? state.ctx;
  }
  return state.ctx;
}

function ensureActiveLLMSpan(
  state: QueryState,
  parentToolUseId: string | null | undefined,
  startTime: Date,
): ActiveLLMSpanState {
  const parentKey = llmParentKey(parentToolUseId);
  const existing = state.activeLLMSpansByParent.get(parentKey);
  if (existing) return existing;

  const parentCtx = getTaskParentContext(state, parentToolUseId);
  const span = state.tracer.startSpan(
    LLM_SPAN_NAME,
    {
      attributes: {
        [OI_SPAN_KIND]: OI_SPAN_KIND_VALUE.LLM,
      },
      startTime,
    },
    parentCtx,
  );
  const llm = { ctx: trace.setSpan(parentCtx, span), span };
  state.activeLLMSpansByParent.set(parentKey, llm);
  return llm;
}

function resolveToolParentContext(
  state: QueryState,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): Context {
  const parentToolUseId = getParentToolUseIdForTool(state, toolUseId, input);
  if (isTaskSiblingTool(toolName)) {
    return getTaskParentContext(state, parentToolUseId);
  }

  const parentKey = llmParentKey(parentToolUseId);
  const activeLLM = state.activeLLMSpansByParent.get(parentKey);
  // Claude hook events can arrive before the assistant message that creates the
  // LLM turn span. In that case, keep the tool under the task/subagent context.
  return activeLLM?.ctx ?? getToolParentContext(state, input);
}

function findActiveAgentToolUseId(state: QueryState): string | undefined {
  for (const tool of state.tools.values()) {
    if (tool.name === 'Agent' && !tool.hasSubagent) return tool.toolUseId;
  }
  return undefined;
}

function canonicalSubagentToolUseId(
  state: QueryState,
  rawToolUseId: string,
  input?: Record<string, unknown>,
): string {
  const existing = state.rawSubagentToolUseIdToToolUseId.get(rawToolUseId);
  if (existing) return existing;

  if (state.tools.has(rawToolUseId)) {
    state.rawSubagentToolUseIdToToolUseId.set(rawToolUseId, rawToolUseId);
    return rawToolUseId;
  }

  const agentId = input ? getString(input, 'agent_id') : undefined;
  const agentToolUseId = agentId ? state.agentIdToToolUseId.get(agentId) : undefined;
  if (agentToolUseId) {
    state.rawSubagentToolUseIdToToolUseId.set(rawToolUseId, agentToolUseId);
    return agentToolUseId;
  }

  const activeAgentToolUseId = findActiveAgentToolUseId(state);
  if (activeAgentToolUseId) {
    state.rawSubagentToolUseIdToToolUseId.set(rawToolUseId, activeAgentToolUseId);
    return activeAgentToolUseId;
  }

  state.rawSubagentToolUseIdToToolUseId.set(rawToolUseId, rawToolUseId);
  return rawToolUseId;
}

function ensureSubagent(
  state: QueryState,
  toolUseId: string,
  input?: Record<string, unknown>,
): SubagentState {
  const existing = state.subagents.get(toolUseId);
  if (existing) return existing;

  const toolState = state.tools.get(toolUseId);
  if (toolState) toolState.hasSubagent = true;
  const parentCtx = toolState?.ctx ?? state.ctx;
  const span = state.tracer.startSpan(
    'Subagent',
    {
      attributes: {
        [OI_SPAN_KIND]: OI_SPAN_KIND_VALUE.AGENT,
        ...(input && getString(input, 'agent_type')
          ? { [CLAUDE_AGENT_ATTRIBUTES.AGENT_TYPE]: getString(input, 'agent_type')! }
          : {}),
        [CLAUDE_AGENT_ATTRIBUTES.TOOL_USE_ID]: toolUseId,
      },
    },
    parentCtx,
  );
  const stateEntry = {
    agentId: input ? getString(input, 'agent_id') : undefined,
    ctx: trace.setSpan(parentCtx, span),
    span,
    toolUseId,
  };
  state.subagents.set(toolUseId, stateEntry);
  if (stateEntry.agentId) state.agentIdToToolUseId.set(stateEntry.agentId, toolUseId);
  return stateEntry;
}

function cleanupToolUseMappings(state: QueryState, rawToolUseId: string, toolUseId: string): void {
  state.toolUseToParent.delete(rawToolUseId);
  state.toolUseToParent.delete(toolUseId);
  state.rawSubagentToolUseIdToToolUseId.delete(rawToolUseId);
}

function cleanupSubagentMappings(state: QueryState, subagent: SubagentState): void {
  if (subagent.agentId) state.agentIdToToolUseId.delete(subagent.agentId);
}

function createTracingHooks(state: QueryState): Record<string, HookMatcher[]> {
  const preToolUse: HookCallback = async (input, toolUseIdArg) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const now = new Date();
    const toolUseId = getToolUseId(input, toolUseIdArg);
    const toolName = getString(input, 'tool_name');
    if (!toolUseId || !toolName) return {};

    const startTime = now;
    const parentCtx = resolveToolParentContext(state, toolUseId, toolName, input);
    const span = state.tracer.startSpan(
      toolName,
      {
        attributes: {
          [OI_SPAN_KIND]: OI_SPAN_KIND_VALUE.TOOL,
          [TOOL_NAME]: toolName,
          [GEN_AI_ATTRIBUTES.TOOL_NAME]: toolName,
          [GEN_AI_ATTRIBUTES.TOOL_CALL_ID]: toolUseId,
          ...(getString(input, 'cwd')
            ? { [CLAUDE_AGENT_ATTRIBUTES.CWD]: getString(input, 'cwd')! }
            : {}),
          ...(getString(input, 'session_id')
            ? { [OI_TRACE_SESSION_ID]: getString(input, 'session_id')! }
            : {}),
        },
        startTime,
      },
      parentCtx,
    );
    setJsonAttribute(span, OI_INPUT_VALUE, input.tool_input);
    state.tools.set(toolUseId, {
      ctx: trace.setSpan(parentCtx, span),
      hasSubagent: false,
      name: toolName,
      span,
      toolUseId,
    });
    return {};
  };

  const postToolUse: HookCallback = async (input, toolUseIdArg) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    const now = new Date();
    const rawToolUseId = getToolUseId(input, toolUseIdArg);
    if (!rawToolUseId) return {};
    const toolUseId = state.tools.has(rawToolUseId)
      ? rawToolUseId
      : canonicalSubagentToolUseId(state, rawToolUseId, input);

    const tool = state.tools.get(toolUseId);
    if (tool) {
      setJsonAttribute(tool.span, OI_OUTPUT_VALUE, input.tool_response);
      tool.span.setStatus({ code: SpanStatusCode.OK });
      tool.span.end(now);
      state.tools.delete(toolUseId);
      cleanupToolUseMappings(state, rawToolUseId, toolUseId);
    }

    const subagent = state.subagents.get(toolUseId);
    const response = input.tool_response;
    if (subagent && !subagent.ended && response && typeof response === 'object') {
      const record = response as Record<string, unknown>;
      const agentType = getString(record, 'agentType');
      if (agentType) subagent.span.setAttribute(CLAUDE_AGENT_ATTRIBUTES.AGENT_TYPE, agentType);
      const agentId = getString(record, 'agentId');
      if (agentId) subagent.span.setAttribute(CLAUDE_AGENT_ATTRIBUTES.AGENT_ID, agentId);
      const durationMs = getNumber(record, 'totalDurationMs');
      if (durationMs !== undefined)
        subagent.span.setAttribute(CLAUDE_AGENT_ATTRIBUTES.DURATION_MS, durationMs);
      const toolUseCount = getNumber(record, 'totalToolUseCount');
      if (toolUseCount !== undefined) {
        subagent.span.setAttribute(CLAUDE_AGENT_ATTRIBUTES.TOOL_USE_COUNT, toolUseCount);
      }
      setJsonAttribute(subagent.span, OI_OUTPUT_VALUE, record.content);
      subagent.span.setStatus({ code: SpanStatusCode.OK });
      subagent.span.end(now);
      subagent.ended = true;
      cleanupSubagentMappings(state, subagent);
    }

    return {};
  };

  const postToolUseFailure: HookCallback = async (input, toolUseIdArg) => {
    if (input.hook_event_name !== 'PostToolUseFailure') return {};
    const now = new Date();
    const rawToolUseId = getToolUseId(input, toolUseIdArg);
    if (!rawToolUseId) return {};
    const toolUseId = state.tools.has(rawToolUseId)
      ? rawToolUseId
      : canonicalSubagentToolUseId(state, rawToolUseId, input);
    const error = getString(input, 'error') ?? 'Tool failed';

    const tool = state.tools.get(toolUseId);
    if (tool) {
      tool.span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      tool.span.recordException(new Error(error));
      tool.span.end(now);
      state.tools.delete(toolUseId);
      cleanupToolUseMappings(state, rawToolUseId, toolUseId);
    }

    const subagent = state.subagents.get(toolUseId);
    if (subagent && !subagent.ended) {
      subagent.span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      subagent.span.recordException(new Error(error));
      subagent.span.end(now);
      subagent.ended = true;
      cleanupSubagentMappings(state, subagent);
    }
    return {};
  };

  const subagentStart: HookCallback = async (input, toolUseIdArg) => {
    if (input.hook_event_name !== 'SubagentStart') return {};
    const rawToolUseId = getToolUseId(input, toolUseIdArg);
    if (!rawToolUseId) return {};
    const toolUseId = canonicalSubagentToolUseId(state, rawToolUseId, input);
    const subagent = ensureSubagent(state, toolUseId, input);
    const agentId = getString(input, 'agent_id');
    if (agentId) {
      subagent.agentId = agentId;
      state.agentIdToToolUseId.set(agentId, toolUseId);
      subagent.span.setAttribute(CLAUDE_AGENT_ATTRIBUTES.AGENT_ID, agentId);
    }
    const agentType = getString(input, 'agent_type');
    if (agentType) subagent.span.setAttribute(CLAUDE_AGENT_ATTRIBUTES.AGENT_TYPE, agentType);
    return {};
  };

  const subagentStop: HookCallback = async (input, toolUseIdArg) => {
    if (input.hook_event_name !== 'SubagentStop') return {};
    const now = new Date();
    const rawToolUseId = getToolUseId(input, toolUseIdArg);
    if (!rawToolUseId) return {};
    const toolUseId = canonicalSubagentToolUseId(state, rawToolUseId, input);
    const subagent = state.subagents.get(toolUseId);
    if (!subagent || subagent.ended) return {};
    const output = input.last_assistant_message;
    if (output !== undefined) setJsonAttribute(subagent.span, OI_OUTPUT_VALUE, output);
    subagent.span.setStatus({ code: SpanStatusCode.OK });
    subagent.span.end(now);
    subagent.ended = true;
    cleanupSubagentMappings(state, subagent);
    return {};
  };

  return {
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
    PreToolUse: [{ hooks: [preToolUse] }],
    SubagentStart: [{ hooks: [subagentStart] }],
    SubagentStop: [{ hooks: [subagentStop] }],
  };
}

function mergeHooks(
  options: ClaudeAgentSDKQueryOptions | undefined,
  hooks: Record<string, HookMatcher[]>,
): ClaudeAgentSDKQueryOptions {
  const existing = options?.hooks ?? {};
  const merged: Record<string, HookMatcher[]> = { ...existing };
  for (const [event, matchers] of Object.entries(hooks)) {
    merged[event] = [...(existing[event] ?? []), ...matchers];
  }
  return { ...(options ?? {}), hooks: merged };
}

function trackToolUseContext(state: QueryState, message: ClaudeAgentSDKMessage): void {
  if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) return;

  const parentToolUseId = message.parent_tool_use_id ?? null;
  for (const block of message.message.content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'tool_use' || typeof record.id !== 'string') continue;
    state.toolUseToParent.set(record.id, parentToolUseId);
  }
}

function emitLLMSpan(state: QueryState, messages: ClaudeAgentSDKMessage[], endTime: Date): void {
  if (messages.length === 0) return;
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];
  if (firstMessage.type !== 'assistant' || !lastMessage.message) return;

  const parentToolUseId = firstMessage.parent_tool_use_id ?? null;
  const parentKey = llmParentKey(parentToolUseId);
  const activeLLM = ensureActiveLLMSpan(state, parentToolUseId, state.currentMessageStartTime);
  const model = getMessageModel(lastMessage, state.params.options);
  const span = activeLLM.span;
  setCommonModel(span, model);
  setUsageAttributes(span, getUsage(lastMessage));
  if (!firstMessage.parent_tool_use_id) {
    if (typeof state.params.prompt === 'string') {
      setJsonAttribute(span, OI_INPUT_VALUE, [{ role: 'user', content: state.params.prompt }]);
    }
  }
  const output = messages
    .map((message) =>
      message.message?.content !== undefined || message.message?.role !== undefined
        ? {
            role: message.message?.role ?? 'assistant',
            content: message.message?.content,
          }
        : undefined,
    )
    .filter((message): message is { role: string; content: unknown } => message !== undefined);
  if (output.length > 0) {
    setJsonAttribute(span, OI_OUTPUT_VALUE, output);
  }
  span.setStatus({ code: SpanStatusCode.OK });
  span.end(endTime);
  state.activeLLMSpansByParent.delete(parentKey);
  state.accumulatedOutputTokens += getUsage(lastMessage)?.output_tokens ?? 0;
  state.currentMessageStartTime = endTime;
}

function flushPendingLLMSpan(state: QueryState, endTime = new Date()): void {
  if (state.pendingAssistantMessages.length === 0) return;
  emitLLMSpan(state, state.pendingAssistantMessages, endTime);
  state.pendingAssistantMessages = [];
}

function shouldFlushBeforeAssistantMessage(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
): boolean {
  const pending = state.pendingAssistantMessages;
  if (pending.length === 0) return false;
  const first = pending[0];
  const nextMessageId = message.message?.id;
  if (nextMessageId && nextMessageId !== state.currentMessageId) return true;
  return (
    first.parent_tool_use_id !== message.parent_tool_use_id ||
    getMessageModel(first, state.params.options) !== getMessageModel(message, state.params.options)
  );
}

function updateCurrentMessageId(state: QueryState, message: ClaudeAgentSDKMessage): void {
  const messageId = message.message?.id;
  if (messageId) state.currentMessageId = messageId;
}

function adjustPendingAssistantUsageFromResult(
  state: QueryState,
  resultMessage: ClaudeAgentSDKMessage,
): void {
  if (state.pendingAssistantMessages.length === 0) return;

  const finalUsage = getUsage(resultMessage);
  if (!finalUsage) return;
  const finalOutputTokens = finalUsage?.output_tokens;
  if (finalOutputTokens === undefined) return;

  const lastMessage = state.pendingAssistantMessages[state.pendingAssistantMessages.length - 1];
  const lastUsage = lastMessage?.message?.usage;
  if (!lastUsage) return;

  const remainingOutputTokens = finalOutputTokens - state.accumulatedOutputTokens;
  if (remainingOutputTokens >= 0) {
    lastUsage.output_tokens = remainingOutputTokens;
  }

  if (finalUsage.cache_read_input_tokens !== undefined) {
    lastUsage.cache_read_input_tokens = finalUsage.cache_read_input_tokens;
  }
  if (finalUsage.cache_creation_input_tokens !== undefined) {
    lastUsage.cache_creation_input_tokens = finalUsage.cache_creation_input_tokens;
  }
}

function processMessage(
  state: QueryState,
  message: ClaudeAgentSDKMessage,
  params: ClaudeAgentSDKQueryParams,
): void {
  trackToolUseContext(state, message);

  if (message.type === 'system' && message.subtype === 'init') {
    const model = typeof message.model === 'string' ? message.model : params.options?.model;
    if (model) state.querySpan.setAttribute(CLAUDE_AGENT_ATTRIBUTES.MODEL, model);
    if (typeof message.session_id === 'string') {
      state.querySpan.setAttribute(OI_TRACE_SESSION_ID, message.session_id);
    }
    return;
  }

  if (message.type === 'assistant') {
    const now = new Date();
    const messageId = message.message?.id;
    if (messageId && messageId !== state.currentMessageId) {
      flushPendingLLMSpan(state, now);
      state.currentMessageId = messageId;
      state.currentMessageStartTime = now;
    } else if (shouldFlushBeforeAssistantMessage(state, message)) {
      flushPendingLLMSpan(state, now);
      updateCurrentMessageId(state, message);
    } else {
      updateCurrentMessageId(state, message);
    }
    if (message.message?.usage) {
      ensureActiveLLMSpan(state, message.parent_tool_use_id ?? null, state.currentMessageStartTime);
    }
    state.pendingAssistantMessages.push(message);
    return;
  }

  if (message.type === 'result') {
    const now = new Date();
    adjustPendingAssistantUsageFromResult(state, message);
    flushPendingLLMSpan(state, now);
    if (typeof message.result === 'string') {
      state.querySpan.setAttribute(OI_OUTPUT_VALUE, message.result);
    }
    if (typeof message.session_id === 'string') {
      state.querySpan.setAttribute(OI_TRACE_SESSION_ID, message.session_id);
    }
    if (typeof message.num_turns === 'number') {
      state.querySpan.setAttribute(CLAUDE_AGENT_ATTRIBUTES.NUM_TURNS, message.num_turns);
    }
    if (typeof message.total_cost_usd === 'number') {
      state.querySpan.setAttribute(CLAUDE_AGENT_ATTRIBUTES.TOTAL_COST_USD, message.total_cost_usd);
    }
  }
}

function endInFlight(state: QueryState, status?: { code: SpanStatusCode; message?: string }): void {
  const now = new Date();
  flushPendingLLMSpan(state, now);

  for (const tool of state.tools.values()) {
    if (status) tool.span.setStatus(status);
    tool.span.end(now);
  }
  state.tools.clear();

  for (const subagent of state.subagents.values()) {
    if (!subagent.ended) {
      if (status) subagent.span.setStatus(status);
      subagent.span.end(now);
      subagent.ended = true;
    }
  }
  state.subagents.clear();
  state.activeLLMSpansByParent.clear();
  state.agentIdToToolUseId.clear();
  state.rawSubagentToolUseIdToToolUseId.clear();
  state.toolUseToParent.clear();
}

function wrapQuery(
  original: NonNullable<ClaudeAgentSDKModule['query']>,
): NonNullable<ClaudeAgentSDKModule['query']> {
  const tracer = trace.getTracer('@traceroot-ai/claude-agent-sdk');

  return function wrappedQuery(
    params: ClaudeAgentSDKQueryParams,
  ): AsyncIterable<ClaudeAgentSDKMessage> {
    const parentCtx = context.active();

    return {
      [Symbol.asyncIterator]() {
        const querySpan = tracer.startSpan(
          QUERY_SPAN_NAME,
          {
            attributes: {
              [OI_SPAN_KIND]: OI_SPAN_KIND_VALUE.AGENT,
              ...(params.options?.model
                ? { [CLAUDE_AGENT_ATTRIBUTES.MODEL]: params.options.model }
                : {}),
            },
          },
          parentCtx,
        );
        if (typeof params.prompt === 'string')
          querySpan.setAttribute(OI_INPUT_VALUE, params.prompt);

        const state: QueryState = {
          accumulatedOutputTokens: 0,
          activeLLMSpansByParent: new Map(),
          agentIdToToolUseId: new Map(),
          currentMessageStartTime: new Date(),
          ctx: trace.setSpan(parentCtx, querySpan),
          params,
          pendingAssistantMessages: [],
          querySpan,
          rawSubagentToolUseIdToToolUseId: new Map(),
          subagents: new Map(),
          toolUseToParent: new Map(),
          tools: new Map(),
          tracer,
        };

        const modifiedParams = {
          ...params,
          options: mergeHooks(params.options, createTracingHooks(state)),
        };

        let finished = false;
        const finish = (
          status: { code: SpanStatusCode; message?: string } = { code: SpanStatusCode.OK },
          error?: unknown,
        ): void => {
          if (finished) return;
          finished = true;
          endInFlight(state, status);
          if (error !== undefined) {
            querySpan.recordException(error instanceof Error ? error : new Error(String(error)));
          }
          querySpan.setStatus(status);
          querySpan.end();
        };

        let inner: AsyncIterator<ClaudeAgentSDKMessage>;
        try {
          inner = original(modifiedParams)[Symbol.asyncIterator]();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          finish({ code: SpanStatusCode.ERROR, message }, error);
          throw error;
        }

        return {
          async next() {
            try {
              const result = await context.with(state.ctx, () => inner.next());
              if (!result.done) {
                processMessage(state, result.value, params);
              } else {
                finish();
              }
              return result;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              finish({ code: SpanStatusCode.ERROR, message }, error);
              throw error;
            }
          },
          async return(value?: unknown) {
            if (finished) return { done: true as const, value: undefined };
            try {
              const result = inner.return
                ? await inner.return(value as ClaudeAgentSDKMessage)
                : { done: true as const, value: undefined };
              finish();
              return result;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              finish({ code: SpanStatusCode.ERROR, message }, error);
              throw error;
            }
          },
          async throw(error?: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (finished) throw error;
            try {
              if (inner.throw) {
                const result = await inner.throw(error);
                finish({ code: SpanStatusCode.ERROR, message }, error);
                return result;
              }
              finish({ code: SpanStatusCode.ERROR, message }, error);
              throw error;
            } catch (thrown) {
              const thrownMessage = thrown instanceof Error ? thrown.message : String(thrown);
              finish({ code: SpanStatusCode.ERROR, message: thrownMessage }, thrown);
              throw thrown;
            }
          },
        };
      },
    };
  };
}

export function wireClaudeAgentSDKInstrumentation(mod: unknown): void {
  const sdk = mod as ClaudeAgentSDKModule & { [WRAPPED]?: boolean };
  if (!sdk || typeof sdk !== 'object' || typeof sdk.query !== 'function') {
    throw new Error(
      '[TraceRoot] instrumentModules.claudeAgentSDK does not expose query. ' +
        'Pass a mutable module namespace, e.g. `{ ...claudeAgentSDK }`.',
    );
  }
  if (sdk[WRAPPED]) return;

  sdk.query = wrapQuery(sdk.query);
  Object.defineProperty(sdk, WRAPPED, {
    configurable: false,
    enumerable: false,
    value: true,
  });
}
