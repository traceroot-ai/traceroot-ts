// src/eval/usage.ts — the LLM usage of each evaluation case, read from the LLM spans the SDK's own
// instrumentation creates in-process (never inferred from a task's output).
//
// The engine runs the task call and each scorer call inside a usage scope (AsyncLocalStorage, so
// concurrent cases never see each other's scope). The collector, a span processor on whichever
// provider the run's spans reach, keys every span started inside a scope by its span id. When the
// case completes, its ended LLM calls are summed per role, counting only leaf LLM spans: an LLM
// span with an LLM-kind descendant wraps the provider call and would count it twice.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Attributes, Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OI_SPAN_KIND } from '../constants';

export type UsageRole = 'task' | 'scorer';

/** One role's LLM usage. snake_case because it is written as-is to the run artifacts and events. */
export interface UsageBucket {
  /** Counted LLM calls. */
  llm_calls: number;
  /** Of those, how many reported an input or output token count. Below `llm_calls`, the token
   *  sums are lower bounds. */
  llm_calls_with_usage: number;
  /** Each token field sums the calls that reported it; null when none did. */
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  /** Sum of the reported `llm.cost.total`, null when no call reported one. Never priced here, so
   *  an unreported cost is unknown, not 0. */
  cost: number | null;
  llm_calls_with_cost: number;
  currency: 'USD' | null;
}

/** A case's (or a run's) usage, split between the candidate task and its scorers. */
export interface CaseUsage {
  task: UsageBucket;
  scorers: UsageBucket;
}

/** What one LLM call reported, each field null when absent. */
interface CallReading {
  input: number | null;
  output: number | null;
  total: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  cost: number | null;
}

// First present convention wins per field; conventions are never summed.
const INPUT_KEYS = [
  'llm.token_count.prompt',
  'gen_ai.usage.input_tokens',
  'ai.usage.promptTokens',
  'ai.usage.inputTokens',
];
const OUTPUT_KEYS = [
  'llm.token_count.completion',
  'gen_ai.usage.output_tokens',
  'ai.usage.completionTokens',
  'ai.usage.outputTokens',
];
const TOTAL_KEYS = ['llm.token_count.total'];
const CACHE_READ_KEYS = [
  'llm.token_count.prompt_details.cache_read',
  'gen_ai.usage.cache_read_input_tokens',
];
const CACHE_WRITE_KEYS = [
  'llm.token_count.prompt_details.cache_write',
  'llm.token_count.prompt_details.cache_creation',
  'gen_ai.usage.cache_creation_input_tokens',
];
const REASONING_KEYS = ['llm.token_count.completion_details.reasoning'];
const COST_KEYS = ['llm.cost.total'];

// The Vercel AI SDK's provider-call operations. Its spans carry no OpenInference kind until the
// export path maps them, and a local run has no export path, so the kind is read from the
// operation name the same way that mapping reads it ("ai.generateText.doGenerate <functionId>").
const VERCEL_LLM_OPERATIONS = new Set([
  'ai.generateText.doGenerate',
  'ai.generateObject.doGenerate',
  'ai.streamText.doStream',
  'ai.streamObject.doStream',
]);

/** An LLM call: OpenInference kind LLM. AGENT / CHAIN / TOOL spans never count, even when they
 *  carry aggregate tokens. */
function isLlmCall(attrs: Attributes): boolean {
  const kind = attrs[OI_SPAN_KIND];
  if (kind !== undefined) return kind === 'LLM';
  const operation = attrs['operation.name'];
  return typeof operation === 'string' && VERCEL_LLM_OPERATIONS.has(operation.split(' ')[0]);
}

function tokenCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  // Half up (2.5 -> 3), the same rounding the Python SDK applies.
  return Math.round(v);
}

function costValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function first(attrs: Attributes, keys: string[], read: (v: unknown) => number | null) {
  for (const key of keys) {
    const value = read(attrs[key]);
    if (value !== null) return value;
  }
  return null;
}

function readCall(attrs: Attributes): CallReading {
  const input = first(attrs, INPUT_KEYS, tokenCount);
  const output = first(attrs, OUTPUT_KEYS, tokenCount);
  const reported = first(attrs, TOTAL_KEYS, tokenCount);
  return {
    input,
    output,
    total: reported ?? (input !== null && output !== null ? input + output : null),
    cacheRead: first(attrs, CACHE_READ_KEYS, tokenCount),
    cacheWrite: first(attrs, CACHE_WRITE_KEYS, tokenCount),
    reasoning: first(attrs, REASONING_KEYS, tokenCount),
    cost: first(attrs, COST_KEYS, costValue),
  };
}

export function emptyBucket(): UsageBucket {
  return {
    llm_calls: 0,
    llm_calls_with_usage: 0,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    cost: null,
    llm_calls_with_cost: 0,
    currency: null,
  };
}

/** null + null stays null (nothing reported); anything reported sums. */
function plus(a: number | null, b: number | null): number | null {
  return b === null ? a : (a ?? 0) + b;
}

function addCall(bucket: UsageBucket, call: CallReading): void {
  bucket.llm_calls += 1;
  if (call.input !== null || call.output !== null) bucket.llm_calls_with_usage += 1;
  bucket.input_tokens = plus(bucket.input_tokens, call.input);
  bucket.output_tokens = plus(bucket.output_tokens, call.output);
  bucket.total_tokens = plus(bucket.total_tokens, call.total);
  bucket.cache_read_tokens = plus(bucket.cache_read_tokens, call.cacheRead);
  bucket.cache_write_tokens = plus(bucket.cache_write_tokens, call.cacheWrite);
  bucket.reasoning_tokens = plus(bucket.reasoning_tokens, call.reasoning);
  if (call.cost !== null) {
    bucket.cost = plus(bucket.cost, call.cost);
    bucket.llm_calls_with_cost += 1;
    bucket.currency = 'USD';
  }
}

function addBucket(into: UsageBucket, b: UsageBucket): void {
  into.llm_calls += b.llm_calls;
  into.llm_calls_with_usage += b.llm_calls_with_usage;
  into.input_tokens = plus(into.input_tokens, b.input_tokens);
  into.output_tokens = plus(into.output_tokens, b.output_tokens);
  into.total_tokens = plus(into.total_tokens, b.total_tokens);
  into.cache_read_tokens = plus(into.cache_read_tokens, b.cache_read_tokens);
  into.cache_write_tokens = plus(into.cache_write_tokens, b.cache_write_tokens);
  into.reasoning_tokens = plus(into.reasoning_tokens, b.reasoning_tokens);
  into.cost = plus(into.cost, b.cost);
  into.llm_calls_with_cost += b.llm_calls_with_cost;
  into.currency = into.cost !== null ? 'USD' : null;
}

/** The sum over cases, or null when no case's usage was captured. */
export function sumUsage(cases: Array<CaseUsage | null | undefined>): CaseUsage | null {
  let total: CaseUsage | null = null;
  for (const usage of cases) {
    if (usage == null) continue;
    total ??= { task: emptyBucket(), scorers: emptyBucket() };
    addBucket(total.task, usage.task);
    addBucket(total.scorers, usage.scorers);
  }
  return total;
}

/** A run's usage: its cases' usage summed. A run with no cases has zero calls when capture was
 *  active, else null ("not captured"). */
export function runUsage(
  cases: Array<CaseUsage | null | undefined>,
  captured: boolean,
): CaseUsage | null {
  const total = sumUsage(cases);
  if (total !== null || !captured || cases.length > 0) return total;
  return { task: emptyBucket(), scorers: emptyBucket() };
}

interface Scope {
  readonly recorder: CaseUsageRecorder;
  readonly role: UsageRole;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Records one case's LLM calls from the moment it is created until finish() or close(). */
export class CaseUsageRecorder {
  private closed = false;
  // Every span started inside this case's scopes, by span id, with its parent's span id: the
  // ancestry the leaf rule walks, through non-LLM spans too.
  private readonly parents = new Map<string, string | undefined>();
  private readonly open = new Set<string>();
  private readonly calls = new Map<string, { role: UsageRole; reading: CallReading }>();

  /** @internal Collector hook. */
  _started(spanId: string, parentSpanId: string | undefined): boolean {
    if (this.closed) return false;
    this.parents.set(spanId, parentSpanId);
    this.open.add(spanId);
    return true;
  }

  /** @internal Collector hook. */
  _ended(spanId: string, role: UsageRole, attrs: Attributes): void {
    this.open.delete(spanId);
    if (this.closed || !isLlmCall(attrs)) return;
    this.calls.set(spanId, { role, reading: readCall(attrs) });
  }

  /** Stop recording; spans that have not ended by now are not counted. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    collector.forget(this.open);
    this.open.clear();
  }

  /**
   * Close and sum the case. A call still running gets one turn of the event loop to end first: a
   * streamed response's span ends when the instrumentation finishes reading its copy of the
   * stream, which can trail the caller's own read.
   */
  async finish(): Promise<CaseUsage> {
    if (!this.closed && this.open.size > 0) await new Promise((r) => setImmediate(r));
    this.close();
    const wrappers = new Set<string>();
    for (const id of this.calls.keys()) {
      const seen = new Set<string>();
      for (let p = this.parents.get(id); p !== undefined && !seen.has(p); p = this.parents.get(p)) {
        seen.add(p);
        if (this.calls.has(p)) wrappers.add(p);
      }
    }
    const usage: CaseUsage = { task: emptyBucket(), scorers: emptyBucket() };
    for (const [id, call] of this.calls) {
      if (wrappers.has(id)) continue;
      addCall(call.role === 'task' ? usage.task : usage.scorers, call.reading);
    }
    return usage;
  }
}

/** Run `fn` with its LLM calls attributed to `recorder` under `role`; a plain call when the run
 *  is not recording usage. */
export function withUsageScope<T>(
  recorder: CaseUsageRecorder | null,
  role: UsageRole,
  fn: () => T,
): T {
  return recorder === null ? fn() : scopes.run({ recorder, role }, fn);
}

/** Span processor that hands every span started inside a usage scope to that scope's case. It
 *  exports nothing and never alters a span. */
export class UsageCollector implements SpanProcessor {
  private readonly tracked = new Map<string, Scope>();

  onStart(span: Span, _parentContext: Context): void {
    try {
      const scope = scopes.getStore();
      if (scope === undefined) return;
      const spanId = span.spanContext().spanId;
      const parent = span.parentSpanId;
      if (scope.recorder._started(spanId, parent)) this.tracked.set(spanId, scope);
    } catch {
      // Usage capture must never break the span it observes.
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const spanId = span.spanContext().spanId;
      const scope = this.tracked.get(spanId);
      if (scope === undefined) return;
      this.tracked.delete(spanId);
      scope.recorder._ended(spanId, scope.role, span.attributes);
    } catch {
      // Usage capture must never break the span it observes.
    }
  }

  /** Drop spans a closed case no longer waits for. */
  forget(spanIds: Iterable<string>): void {
    for (const id of spanIds) this.tracked.delete(id);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** The one collector, added to the exporting provider and to the local capture provider alike. */
export const collector = new UsageCollector();
