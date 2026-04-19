// src/constants.ts — TraceRoot-specific span attribute keys and SDK defaults

// Flush/batch defaults — mirror traceroot-py/traceroot/constants.py
export const DEFAULT_FLUSH_INTERVAL_SEC = 5; // seconds → BatchSpanProcessor scheduledDelayMillis (×1000)
export const DEFAULT_FLUSH_AT = 100; // BatchSpanProcessor maxExportBatchSize
export const DEFAULT_TIMEOUT_SEC = 30; // seconds → BatchSpanProcessor exportTimeoutMillis (×1000)

// Span-level
export const SPAN_METADATA = 'traceroot.span.metadata';
export const SPAN_TAGS = 'traceroot.span.tags';

// LLM-specific
export const LLM_MODEL = 'traceroot.llm.model';
export const LLM_MODEL_PARAMETERS = 'traceroot.llm.model_parameters';
export const LLM_USAGE = 'traceroot.llm.usage';
export const LLM_PROMPT = 'traceroot.llm.prompt';

// Trace-level
export const TRACE_METADATA = 'traceroot.trace.metadata';
export const TRACE_TAGS = 'traceroot.trace.tags';

/**
 * All TraceRoot span attribute key constants in one object.
 * Use these instead of hardcoding strings when setting custom span attributes.
 *
 * @example
 * import { SpanAttributes } from '@traceroot-ai/traceroot';
 * span.setAttribute(SpanAttributes.LLM_MODEL, 'gpt-4o');
 */
export const SpanAttributes = {
  // Span-level
  SPAN_TYPE: 'traceroot.span.type',
  SPAN_INPUT: 'input.value', // OpenInference
  SPAN_OUTPUT: 'output.value', // OpenInference
  SPAN_METADATA,
  SPAN_TAGS,

  // LLM-specific
  LLM_MODEL,
  LLM_MODEL_PARAMETERS,
  LLM_USAGE,
  LLM_PROMPT,

  // Trace-level
  TRACE_USER_ID: 'user.id', // OpenInference
  TRACE_SESSION_ID: 'session.id', // OpenInference
  TRACE_METADATA,
  TRACE_TAGS,

  // Git context
  GIT_REPO: 'traceroot.git.repo',
  GIT_REF: 'traceroot.git.ref',
  GIT_SOURCE_FILE: 'traceroot.git.source_file',
  GIT_SOURCE_LINE: 'traceroot.git.source_line',
  GIT_SOURCE_FUNCTION: 'traceroot.git.source_function',

  // Deployment
  ENVIRONMENT: 'deployment.environment',
} as const;
