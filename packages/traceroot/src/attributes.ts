// src/attributes.ts — native field → OTel attribute mapping (single source of truth)
import { Span, context } from '@opentelemetry/api';
import { getAttributesFromContext } from '@arizeai/openinference-core';
import {
  INPUT_VALUE,
  OUTPUT_VALUE,
  SemanticConventions,
  SESSION_ID,
  USER_ID,
} from '@arizeai/openinference-semantic-conventions';
import {
  SPAN_METADATA,
  SPAN_TAGS,
  OI_LLM_MODEL_NAME,
  LLM_MODEL,
  LLM_MODEL_PARAMETERS,
  LLM_USAGE,
  OI_LLM_TOKEN_COUNT_PROMPT,
  OI_LLM_TOKEN_COUNT_COMPLETION,
  OI_LLM_TOKEN_COUNT_TOTAL,
  OI_LLM_TOKEN_COUNT_CACHE_READ,
  OI_LLM_TOKEN_COUNT_CACHE_WRITE,
} from './constants';
import { ObserveOptions, SpanType, TokenUsage } from './types';
import { captureSourceLocation } from './git_context';

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND;

export const SPAN_KIND_MAP: Record<SpanType, string> = {
  agent: 'AGENT',
  tool: 'TOOL',
  llm: 'LLM',
  span: 'CHAIN',
  // Offline-evaluation kinds (additive).
  evaluation: 'CHAIN',
  task: 'CHAIN',
  scorer: 'EVALUATOR',
};

export function trySerialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function applyModel(
  span: Span,
  model?: string,
  modelParameters?: Record<string, unknown>,
): void {
  if (model !== undefined) {
    span.setAttribute(OI_LLM_MODEL_NAME, model); // read by backend
    span.setAttribute(LLM_MODEL, model); // back-compat
  }
  if (modelParameters !== undefined) {
    const s = trySerialize(modelParameters);
    if (s !== undefined) span.setAttribute(LLM_MODEL_PARAMETERS, s);
  }
}

export function applyUsage(span: Span, usage: TokenUsage): void {
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const output = usage.output ?? 0;
  const prompt = input + cacheRead + cacheWrite; // GROSS
  if (prompt > 0) span.setAttribute(OI_LLM_TOKEN_COUNT_PROMPT, prompt);
  if (output > 0) span.setAttribute(OI_LLM_TOKEN_COUNT_COMPLETION, output);
  const total = usage.total ?? prompt + output;
  if (total > 0) span.setAttribute(OI_LLM_TOKEN_COUNT_TOTAL, total);
  if (cacheRead > 0) span.setAttribute(OI_LLM_TOKEN_COUNT_CACHE_READ, cacheRead);
  if (cacheWrite > 0) span.setAttribute(OI_LLM_TOKEN_COUNT_CACHE_WRITE, cacheWrite);
  // Preserve the full object (incl. any custom keys) as a blob for completeness.
  const blob = trySerialize(usage);
  if (blob !== undefined) span.setAttribute(LLM_USAGE, blob);
}

export function applyIO(span: Span, io: { input?: unknown; output?: unknown }): void {
  if (io.input !== undefined) {
    const s = trySerialize(io.input);
    if (s !== undefined) span.setAttribute(INPUT_VALUE, s);
  }
  if (io.output !== undefined) {
    const s = trySerialize(io.output);
    if (s !== undefined) span.setAttribute(OUTPUT_VALUE, s);
  }
}

/** Moved verbatim from observe.ts:_applyCommonAttributes (kind, ambient ctx,
 *  session/user, input-from-args, metadata, tags, git source). */
export function applyCommonAttributes(span: Span, options: ObserveOptions, args: unknown[]): void {
  span.setAttribute(OPENINFERENCE_SPAN_KIND, SPAN_KIND_MAP[options.type ?? 'span']);

  const ctxAttrs = getAttributesFromContext(context.active());
  if (ctxAttrs && Object.keys(ctxAttrs).length > 0) span.setAttributes(ctxAttrs);

  if (options.sessionId !== undefined) span.setAttribute(SESSION_ID, options.sessionId);
  if (options.userId !== undefined) span.setAttribute(USER_ID, options.userId);

  if (options.captureInput !== false && args.length > 0) {
    const inputValue = args.length === 1 ? args[0] : args;
    const s = trySerialize(inputValue);
    if (s !== undefined) span.setAttribute(INPUT_VALUE, s);
  }
  if (options.metadata !== undefined) {
    const s = trySerialize(options.metadata);
    if (s !== undefined) span.setAttribute(SPAN_METADATA, s);
  }
  if (options.tags !== undefined) {
    const s = trySerialize(options.tags);
    if (s !== undefined) span.setAttribute(SPAN_TAGS, s);
  }

  const loc = captureSourceLocation();
  if (loc.file !== undefined) span.setAttribute('traceroot.git.source_file', loc.file);
  if (loc.line !== undefined) span.setAttribute('traceroot.git.source_line', loc.line);
  if (loc.functionName !== undefined)
    span.setAttribute('traceroot.git.source_function', loc.functionName);
}
