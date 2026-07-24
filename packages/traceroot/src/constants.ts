// src/constants.ts — TraceRoot-specific span attribute keys and SDK defaults

// GitHub Actions environment variable names used for git-context harvesting.
export const GITHUB_REPOSITORY = 'GITHUB_REPOSITORY';
export const GITHUB_SHA = 'GITHUB_SHA';

// Flush/batch defaults — mirror traceroot-py/traceroot/constants.py
export const DEFAULT_FLUSH_INTERVAL_SEC = 5; // seconds → BatchSpanProcessor scheduledDelayMillis (×1000)
export const DEFAULT_FLUSH_AT = 100; // BatchSpanProcessor maxExportBatchSize
export const DEFAULT_TIMEOUT_SEC = 30; // seconds → BatchSpanProcessor exportTimeoutMillis (×1000)

// Span-level
export const OI_SPAN_KIND = 'openinference.span.kind';
export const OI_INPUT_VALUE = 'input.value';
export const OI_OUTPUT_VALUE = 'output.value';
export const SPAN_METADATA = 'traceroot.span.metadata';
export const SPAN_TAGS = 'traceroot.span.tags';
export const AGENT_NAME = 'agent.name';
export const TOOL_NAME = 'tool.name';

// LLM-specific
export const OI_LLM_MODEL_NAME = 'llm.model_name';
export const OI_LLM_TOKEN_COUNT_PROMPT = 'llm.token_count.prompt';
export const OI_LLM_TOKEN_COUNT_COMPLETION = 'llm.token_count.completion';
export const OI_LLM_TOKEN_COUNT_TOTAL = 'llm.token_count.total';
export const OI_LLM_TOKEN_COUNT_CACHE_READ = 'llm.token_count.prompt_details.cache_read';
export const OI_LLM_TOKEN_COUNT_CACHE_WRITE = 'llm.token_count.prompt_details.cache_write';
export const LLM_MODEL = 'traceroot.llm.model';
export const LLM_MODEL_PARAMETERS = 'traceroot.llm.model_parameters';
export const LLM_USAGE = 'traceroot.llm.usage';
export const LLM_PROMPT = 'traceroot.llm.prompt';

// Trace-level
export const OI_TRACE_USER_ID = 'user.id';
export const OI_TRACE_SESSION_ID = 'session.id';
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
  SPAN_INPUT: OI_INPUT_VALUE, // OpenInference
  SPAN_OUTPUT: OI_OUTPUT_VALUE, // OpenInference
  SPAN_METADATA,
  SPAN_TAGS,

  // LLM-specific
  LLM_MODEL,
  LLM_MODEL_PARAMETERS,
  LLM_USAGE,
  LLM_PROMPT,

  // Trace-level
  TRACE_USER_ID: OI_TRACE_USER_ID, // OpenInference
  TRACE_SESSION_ID: OI_TRACE_SESSION_ID, // OpenInference
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

  // Offline evaluation — versioned identity contract (parity with Python span_attributes).
  TRACEROOT_ENVIRONMENT: 'traceroot.environment',
  EVAL_CONTRACT_VERSION: 'traceroot.eval.contract_version',
  EVAL_NAME: 'traceroot.eval.name',
  EVAL_RUN_NAME: 'traceroot.eval.run_name',
  EVAL_RUN_ID: 'traceroot.eval.run_id',
  EVAL_LOCAL_RUN_ID: 'traceroot.eval.local_run_id',
  EVAL_DATASET_NAME: 'traceroot.eval.dataset_name',
  EVAL_DATASET_ID: 'traceroot.eval.dataset_id',
  EVAL_DATASET_VERSION_ID: 'traceroot.eval.dataset_version_id',
  EVAL_CASE_ID: 'traceroot.eval.case_id',
  EVAL_CANDIDATE_VERSION: 'traceroot.eval.candidate_version',
  EVAL_ENVIRONMENT: 'traceroot.eval.environment',
  EVAL_HAS_EXPECTED: 'traceroot.eval.has_expected',
  EVAL_SOURCE_TRACE_ID: 'traceroot.eval.source_trace_id',
  EVAL_SOURCE_SPAN_ID: 'traceroot.eval.source_span_id',
  EVAL_SCORE_TARGET_SPAN_ID: 'traceroot.eval.score_target_span_id',
  EVAL_TASK_NAME: 'traceroot.eval.task_name',
  EVAL_ERROR: 'traceroot.eval.error',
  EVAL_SCORER_NAME: 'traceroot.eval.scorer_name',
  EVAL_SCORE_VALUE: 'traceroot.eval.score_value',
  EVAL_SCORE_COMMENT: 'traceroot.eval.score_comment',
} as const;
