// src/eval/scorers.ts — first-class scorer comparison metadata (parity with
// traceroot-py/traceroot/eval/scorers.py).
//
// A scorer is any callable (ScorerContext) -> value | Score. The optional scorer() wrapper
// DESCRIBES a scorer so the platform compares candidates correctly — value type, direction,
// threshold, version — without a class hierarchy. Plain callables keep working.
//
//     const accuracy = scorer((ctx) => ..., { valueType: 'numeric', direction: 'higher_is_better', threshold: 0.9 });
//     const latency  = scorer((ctx) => ..., { valueType: 'numeric', direction: 'lower_is_better' });
//     const isSafe   = scorer((ctx) => ..., { valueType: 'boolean' });         // True is good
//     const route    = scorer((ctx) => ..., { valueType: 'categorical' });     // no ordering
//
// Defaults: numeric/boolean -> higher_is_better; categorical -> none. Explicit direction
// always wins. Direction is NEVER inferred from the scorer name. A version is only reported
// when explicitly declared — never fabricated.

import { trace } from '@opentelemetry/api';

import type { ScorerContext, Score, DeferredScore } from './types';
import { canonicalHash } from './canonical';
import { observe } from '../observe';
import { isProviderInstrumented } from '../instrumentation';
import { TraceRoot } from '../traceroot';
import {
  OI_LLM_TOKEN_COUNT_CACHE_CREATION,
  OI_LLM_TOKEN_COUNT_CACHE_READ,
  OI_LLM_TOKEN_COUNT_COMPLETION,
  OI_LLM_TOKEN_COUNT_PROMPT,
  OI_LLM_TOKEN_COUNT_TOTAL,
} from '../constants';

/**
 * Whether an active provider integration already traces this model's calls, so the judge must
 * NOT add its own LLM span (an LLM span nested inside an LLM span is redundant). The provider is
 * inferred from the model id the same way defaultComplete dispatches.
 */
function providerIntegrationTraces(model: string): boolean {
  const m = (model || '').toLowerCase();
  const provider = m.startsWith('claude') || m.startsWith('anthropic') ? 'anthropic' : 'openAI';
  try {
    return isProviderInstrumented(provider);
  } catch {
    return false;
  }
}

export const VALUE_TYPES = ['numeric', 'boolean', 'categorical'] as const;
export const DIRECTIONS = ['higher_is_better', 'lower_is_better', 'none'] as const;
export const OUTPUT_TYPES = ['score', 'classification'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];
export type Direction = (typeof DIRECTIONS)[number];
export type OutputType = (typeof OUTPUT_TYPES)[number];
export type ScorerType = 'code' | 'llm_judge';
export interface JudgeMessage {
  role: string;
  content: string;
}

// The ScorerContext fields a scorer may declare it needs. An extensible descriptor (not a
// narrow reference_based boolean): output-only scorers declare ['output'], a reference
// scorer adds 'expected', etc. Absent = unknown (never assumed).
export const REQUIRED_INPUTS = ['input', 'output', 'expected', 'metadata', 'trace'] as const;
export type RequiredInput = (typeof REQUIRED_INPUTS)[number];

/** Validate + canonically order a declared requiredInputs list. */
export function validateRequiredInputs(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new Error('requiredInputs must be an array of strings');
  }
  const unknown = value.filter((x) => !(REQUIRED_INPUTS as readonly string[]).includes(x));
  if (unknown.length > 0) {
    throw new Error(
      `requiredInputs must be a subset of ${REQUIRED_INPUTS.join(', ')}, got ${unknown.join(', ')}`,
    );
  }
  const present = new Set(value);
  return REQUIRED_INPUTS.filter((x) => present.has(x));
}

const REQUIRED_INPUT_PLACEHOLDER = /\{\{\s*(input|output|expected)\s*\}\}/g;

/** ScorerContext fields an llm_judge template references, derived from its placeholders
 *  (canonical order). null when no messages; [] when the prompt references no case fields. */
function deriveRequiredInputs(messages: JudgeMessage[] | undefined): string[] | null {
  if (!messages || messages.length === 0) return null;
  const found = new Set<string>();
  for (const msg of messages) {
    const content = typeof msg?.content === 'string' ? msg.content : '';
    for (const m of content.matchAll(REQUIRED_INPUT_PLACEHOLDER)) found.add(m[1]);
  }
  return REQUIRED_INPUTS.filter((x) => found.has(x));
}

export type ScoreLikeReturn =
  | number
  | boolean
  | string
  | Score
  | Score[]
  | Record<string, number | boolean | string> // a metric -> value map (one Score per entry)
  | DeferredScore
  | null
  | undefined;
export type Scorer = (ctx: ScorerContext) => ScoreLikeReturn | Promise<ScoreLikeReturn>;

export interface ScorerMeta {
  /** Stable SEMANTIC identity, independent of function spelling/language. Set it identically in
   *  Python and TypeScript to make the SAME logical scorer resolve across languages. Defaults to
   *  the definition name; never derived from source (code/language/version are provenance). */
  key?: string;
  name?: string;
  version?: string;
  valueType?: ValueType;
  direction?: Direction;
  threshold?: number;
  outputType?: OutputType;
  description?: string;
  metadata?: Record<string, unknown>;
  requiredInputs?: string[];
  // Set by llmJudge(); code scorers leave scorerType undefined (defaults to "code").
  scorerType?: ScorerType;
  model?: string;
  messages?: JudgeMessage[];
}

const META = Symbol.for('traceroot.scorer.meta');

export interface ScorerDescriptor {
  key: string;
  name: string;
  version: string | null;
  scorer_type: ScorerType;
  value_type: ValueType | null;
  direction: Direction | null;
  threshold: number | null;
  output_type: OutputType | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  required_inputs?: string[];
  language?: string;
  source?: string;
  model?: string;
  messages?: JudgeMessage[];
}

/** Attach comparison metadata to a scorer callable. Returns the same function. */
export function scorer(fn: Scorer, opts: ScorerMeta = {}): Scorer {
  if (opts.valueType !== undefined && !VALUE_TYPES.includes(opts.valueType)) {
    throw new Error(`valueType must be one of ${VALUE_TYPES.join(', ')}, got ${opts.valueType}`);
  }
  if (opts.direction !== undefined && !DIRECTIONS.includes(opts.direction)) {
    throw new Error(`direction must be one of ${DIRECTIONS.join(', ')}, got ${opts.direction}`);
  }
  if (opts.outputType !== undefined && !OUTPUT_TYPES.includes(opts.outputType)) {
    throw new Error(`outputType must be one of ${OUTPUT_TYPES.join(', ')}, got ${opts.outputType}`);
  }
  if (opts.requiredInputs !== undefined) {
    opts = { ...opts, requiredInputs: validateRequiredInputs(opts.requiredInputs) };
  }
  const prev = (fn as any)[META] as ScorerMeta | undefined;
  const meta: ScorerMeta = { ...prev };
  for (const k of [
    'key',
    'name',
    'version',
    'valueType',
    'direction',
    'threshold',
    'outputType',
    'description',
    'metadata',
    'requiredInputs',
  ] as const) {
    if (opts[k] !== undefined) (meta as any)[k] = opts[k];
  }
  (fn as any)[META] = meta;
  return fn;
}

function declared<K extends keyof ScorerMeta>(fn: Scorer, key: K): ScorerMeta[K] | undefined {
  const meta = (fn as any)[META] as ScorerMeta | undefined;
  if (meta && meta[key] !== undefined) return meta[key];
  // Back-compat: a plainly-set property (e.g. fn.version = '2') also counts as declared.
  const plain = (fn as any)[key];
  return plain === undefined ? undefined : plain;
}

/** The scorer's explicitly declared version, or null (never fabricated). */
export function declaredVersion(fn: Scorer): string | null {
  return declared(fn, 'version') ?? null;
}

/**
 * The ONE place a scorer's reported name is resolved: declared name -> function name -> fallback.
 * Every site that names a scorer (the emitted Score, the scorer->metric ownership map, the span,
 * the registration/completion manifest) must route through this, or the platform sees a metric it
 * cannot attribute to its definition. `''` counts as absent at every step: an arrow passed as a
 * call argument has the built-in `fn.name === ''`, which would otherwise land in `key` (the
 * identity field) and collapse distinct scorers onto one name.
 */
export function scorerName(fn: NamedCallable, fallback = 'scorer'): string {
  return declared(fn as Scorer, 'name') || fnName(fn, fallback);
}

/** Any callable we name (a scorer, a run scorer). */
type NamedCallable = { name?: string } & ((...args: never[]) => unknown);

function fnName(fn: NamedCallable, fallback = 'scorer'): string {
  return fn.name && fn.name.length > 0 ? fn.name : fallback;
}

/** The scorer's source verbatim (via `Function.prototype.toString`), or null for native fns. */
function captureSource(fn: Scorer): string | null {
  const src = Function.prototype.toString.call(fn).trim();
  return src.includes('[native code]') || src.length === 0 ? null : src;
}

/**
 * Build a scorer descriptor: identity + comparison metadata + the read-only definition.
 * Shared fields plus, per scorer_type, language+source (code) or model+messages (llm judge).
 * Absent fields are null (shared) / omitted (type-specific), never fabricated.
 */
export function scorerMetadata(fn: Scorer, valueTypeHint?: ValueType): ScorerDescriptor {
  const name = scorerName(fn);
  const key = declared(fn, 'key') || name; // stable semantic identity; defaults to the definition name
  const declaredOutput: OutputType | null = declared(fn, 'outputType') ?? null;
  // value type: declared > runtime hint > inferred from outputType. Inferring from outputType
  // (score -> numeric, classification -> categorical) keeps an llmJudge that only declares
  // outputType from reporting a null value_type/direction, so run comparisons stay consistent.
  let vtype = declared(fn, 'valueType') ?? valueTypeHint ?? null;
  if (vtype === null && declaredOutput !== null) {
    vtype = declaredOutput === 'classification' ? 'categorical' : 'numeric';
  }
  let direction = declared(fn, 'direction') ?? null;
  if (direction === null && vtype !== null) {
    direction = vtype === 'categorical' ? 'none' : 'higher_is_better';
  }
  const scorerType: ScorerType = declared(fn, 'scorerType') ?? 'code';
  let outputType: OutputType | null = declaredOutput;
  if (outputType === null && vtype !== null) {
    outputType = vtype === 'categorical' ? 'classification' : 'score';
  }
  // Declared requirements win; an llm_judge otherwise derives them from its template
  // placeholders. A bare/undeclared code scorer stays unknown (omitted): we never claim
  // 'expected' is required just because it exists on the context.
  let requiredInputs = declared(fn, 'requiredInputs') ?? null;
  if (requiredInputs === null && scorerType === 'llm_judge') {
    requiredInputs = deriveRequiredInputs(declared(fn, 'messages'));
  }
  const desc: ScorerDescriptor = {
    key,
    name,
    version: declaredVersion(fn),
    scorer_type: scorerType,
    value_type: vtype,
    direction,
    threshold: declared(fn, 'threshold') ?? null,
    output_type: outputType,
    description: declared(fn, 'description') ?? null,
    metadata: declared(fn, 'metadata') ?? null,
  };
  if (requiredInputs !== null) desc.required_inputs = requiredInputs;
  if (scorerType === 'llm_judge') {
    desc.model = declared(fn, 'model');
    desc.messages = declared(fn, 'messages');
    // A DYNAMIC judge also carries its builder-callback provenance; a static judge has none (its
    // declarative config IS its source, via the config-hash version).
    const builderSource = (declared(fn, 'builderSource' as any) as string | undefined) ?? null;
    if (builderSource !== null) {
      desc.language = 'typescript';
      desc.source = builderSource;
    }
  } else {
    const src = captureSource(fn);
    if (src !== null) {
      desc.language = 'typescript';
      desc.source = src;
    }
  }
  return desc;
}

/** Descriptor list for a set of scorers. `valueTypes` maps scorer name -> a runtime hint. */
export function describeScorers(
  scorers: Scorer[],
  valueTypes: Record<string, ValueType> = {},
): ScorerDescriptor[] {
  // Key the hint lookup by the DECLARED name (what the rendered descriptor uses), not the raw
  // implementation function name — otherwise a scorer(fn, { name }) never receives its hint.
  return scorers.map((s) => scorerMetadata(s, valueTypes[scorerName(s)]));
}

// --- LLM-judge scorer ----------------------------------------------------------------

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function renderMessages(messages: JudgeMessage[], ctx: ScorerContext): JudgeMessage[] {
  const values: Record<string, string> = {
    input: asText(ctx.input),
    output: asText(ctx.output),
    expected: asText(ctx.expected),
  };
  return messages.map((m) => ({
    role: m.role ?? 'user',
    content: (m.content ?? '').replace(
      /\{\{\s*(input|output|expected)\s*\}\}/g,
      (_s, k) => values[k],
    ),
  }));
}

/**
 * Parse a judge's response into a score. The judge contract is "reply with a single number
 * and nothing else", so the response itself is the number. To avoid the "first number wins"
 * footgun (`Step 3: the score is 0.8` must NOT become 3), accept an exact numeric response or
 * a single unambiguous number in prose, and otherwise throw -- a malformed/ambiguous response
 * is an isolated scorer error with the raw text preserved, never a wrong silent score.
 */
function parseJudgeOutput(text: string, outputType: OutputType): number | string {
  if (outputType === 'classification') return (text ?? '').trim();
  const stripped = (text ?? '').trim();
  const candidate = stripped.replace(/\.+$/, ''); // tolerate a trailing period on an exact answer
  if (/^-?\d+(?:\.\d+)?$/.test(candidate)) return Number(candidate);
  const numbers = stripped.match(/-?\d+(?:\.\d+)?/g) ?? [];
  if (numbers.length === 1) return Number(numbers[0]);
  throw new Error(
    `llmJudge: expected a single numeric score, found ${numbers.length} in model output: ` +
      JSON.stringify(stripped.slice(0, 200)),
  );
}

/** Token usage as the judge's own LLM span reports it. Undefined fields are simply not emitted —
 *  a count is never invented, because the BACKEND prices whatever token attributes arrive. */
interface JudgeUsage {
  prompt?: number;
  completion?: number;
  total?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** The default dispatch's result: the judge's answer plus the provider's usage when it reported
 *  one. A user-supplied `complete` returns text only, so its usage is undefined. */
interface JudgeCompletion {
  text: string;
  usage?: JudgeUsage;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Anthropic usage -> the OpenInference counts. `input_tokens` EXCLUDES cached/created input, so
 *  prompt sums the three — identical to the SDK's own claude-agent-sdk instrumentation (and to
 *  traceroot-py), so the same judge call prices the same however it was traced. */
function anthropicUsage(raw: unknown): JudgeUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreation = num(u.cache_creation_input_tokens);
  const input = num(u.input_tokens);
  const completion = num(u.output_tokens);
  const prompt =
    input === undefined && cacheRead === undefined && cacheCreation === undefined
      ? undefined
      : (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
  if (prompt === undefined && completion === undefined) return undefined;
  // Anthropic reports no total of its own; both parts are known here (the guard above), so this
  // is a sum of reported counts, not an estimate.
  return { prompt, completion, total: (prompt ?? 0) + (completion ?? 0), cacheRead, cacheCreation };
}

/** OpenAI usage -> the OpenInference counts. `prompt_tokens` already includes cached input, and
 *  the provider reports `total_tokens` itself, so nothing is recomputed. */
function openaiUsage(raw: unknown): JudgeUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const total = num(u.total_tokens);
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  const details = u.prompt_tokens_details;
  const cacheRead =
    typeof details === 'object' && details !== null
      ? num((details as Record<string, unknown>).cached_tokens)
      : undefined;
  return { prompt, completion, total, cacheRead };
}

/**
 * Emit the judge's token usage on the CURRENT span (the judge's own LLM span, opened by observe()
 * just below). The SDK never computes a dollar cost — it emits the OpenInference token counts and
 * the backend prices them on ingest, exactly as it does for an auto-instrumented LLM call.
 */
function setJudgeTokenCounts(usage: JudgeUsage): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const set = (key: string, value: number | undefined) => {
    if (value !== undefined) span.setAttribute(key, value);
  };
  set(OI_LLM_TOKEN_COUNT_PROMPT, usage.prompt);
  set(OI_LLM_TOKEN_COUNT_COMPLETION, usage.completion);
  set(OI_LLM_TOKEN_COUNT_TOTAL, usage.total);
  set(OI_LLM_TOKEN_COUNT_CACHE_READ, usage.cacheRead);
  set(OI_LLM_TOKEN_COUNT_CACHE_CREATION, usage.cacheCreation);
}

/** How the default dispatch loads a provider SDK. Overridable for tests (see
 *  `_setJudgeProviderImport`) so the dispatch itself can be exercised without a network. */
let providerImport: (pkg: string) => Promise<any> = (pkg) => import(pkg);

/** @internal — test seam: swap the provider-SDK loader (pass null to restore the real import). */
export function _setJudgeProviderImport(fn: ((pkg: string) => Promise<any>) | null): void {
  providerImport = fn ?? ((pkg) => import(pkg));
}

async function defaultComplete(model: string, messages: JudgeMessage[]): Promise<JudgeCompletion> {
  const pkg =
    model.startsWith('claude') || model.startsWith('anthropic') ? '@anthropic-ai/sdk' : 'openai';
  let mod: any;
  try {
    mod = await providerImport(pkg);
  } catch {
    throw new Error(`llmJudge needs the '${pkg}' package to call this model, or pass complete=...`);
  }
  if (pkg === '@anthropic-ai/sdk') {
    const system =
      messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n') || undefined;
    const turns = messages.filter((m) => m.role !== 'system');
    const client = new mod.default();
    const resp = await client.messages.create({ model, max_tokens: 512, system, messages: turns });
    return {
      text: (resp.content ?? []).map((b: any) => b.text ?? '').join(''),
      usage: anthropicUsage(resp.usage),
    };
  }
  const client = new mod.default();
  const resp = await client.chat.completions.create({ model, messages });
  return {
    text: resp.choices[0]?.message?.content ?? '',
    usage: openaiUsage(resp.usage),
  };
}

/** A dynamic judge's builder: given the case, returns the judge's template variables (a `{{VAR}}`
 *  map) OR the messages to send. It supplies prompt inputs — never the final score. */
export type JudgeBuilder = (
  ctx: ScorerContext,
) => Record<string, unknown> | JudgeMessage[] | Promise<Record<string, unknown> | JudgeMessage[]>;

export interface LlmJudgeOptions {
  name: string;
  /** Stable cross-language identity (defaults to `name`). */
  key?: string;
  model: string;
  /** The full authored prompt template. Provide this OR `rubric`. */
  messages?: JudgeMessage[];
  /** Shorthand: a grading instruction; expands to a system message + `{{output}}` user message. */
  rubric?: string;
  version?: string;
  outputType?: OutputType;
  threshold?: number;
  description?: string;
  metadata?: Record<string, unknown>;
  direction?: Direction;
  valueType?: ValueType;
  /** Override the derived required inputs (default: from the template placeholders). */
  requiredInputs?: string[];
  /** Override the model call (tests / custom providers). Default: lazy anthropic/openai. */
  complete?: (model: string, messages: JudgeMessage[]) => string | Promise<string>;
}

/**
 * A first-class LLM-judge scorer: its `model` + `messages` (authored template) are carried
 * as the reported definition; calling it renders {{input}}/{{output}}/{{expected}} per case
 * and runs the model. Parity with Python `llm_judge`.
 */
/** A general {{VAR}} placeholder (any identifier), for rendering a dynamic judge's builder vars. */
const ANY_PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

function asJudgeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Deterministic revision of a judge's DECLARATIVE config (its versioned 'source'): the SHARED
 *  canonical JSON (snake_case keys) -> sha256, byte-identical to Python's `_config_revision`. The
 *  version must change only when the rubric changes, never when the authoring language changes. */
function configRevision(config: Record<string, unknown>): string {
  return 'cfg_' + canonicalHash(config, 16);
}

function renderVars(messages: JudgeMessage[], variables: Record<string, string>): JudgeMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: (m.content ?? '').replace(ANY_PLACEHOLDER, (whole, k: string) =>
      Object.prototype.hasOwnProperty.call(variables, k) ? variables[k] : whole,
    ),
  }));
}

function renderBuilt(
  messages: JudgeMessage[],
  built: Record<string, unknown> | JudgeMessage[],
  ctx: ScorerContext,
  name: string,
): JudgeMessage[] {
  if (Array.isArray(built)) return renderMessages(built, ctx); // dynamic messages
  if (built && typeof built === 'object') {
    const base: Record<string, string> = {
      input: asJudgeText(ctx.input),
      output: asJudgeText(ctx.output),
      expected: asJudgeText(ctx.expected),
    };
    for (const [k, v] of Object.entries(built)) base[k] = asJudgeText(v);
    return renderVars(messages, base);
  }
  throw new Error(
    `llmJudge ${JSON.stringify(name)}: a dynamic builder must return an object (template ` +
      `variables) or an array (messages), got ${typeof built}.`,
  );
}

export function llmJudge(opts: LlmJudgeOptions, builder?: JudgeBuilder): Scorer {
  const outputType: OutputType = opts.outputType ?? 'score';
  if (!OUTPUT_TYPES.includes(outputType)) {
    throw new Error(`outputType must be one of ${OUTPUT_TYPES.join(', ')}, got ${outputType}`);
  }
  const requiredInputs =
    opts.requiredInputs !== undefined ? validateRequiredInputs(opts.requiredInputs) : undefined;
  // `rubric` is a shorthand for a grading system message; `messages` is the full template. One required.
  const messages: JudgeMessage[] =
    opts.messages ??
    (opts.rubric !== undefined
      ? [
          { role: 'system', content: opts.rubric },
          { role: 'user', content: '{{output}}' },
        ]
      : (() => {
          throw new Error('llmJudge requires `messages` or `rubric`');
        })());
  // The declarative config IS the judge's versioned source: hash it deterministically. Explicit wins.
  const resolvedVersion =
    opts.version ??
    // snake_case keys: the hashed payload is the SHARED cross-SDK shape, not this SDK's casing.
    configRevision({
      model: opts.model,
      messages,
      output_type: outputType,
      threshold: opts.threshold ?? null,
      direction: opts.direction ?? null,
      value_type: opts.valueType ?? null,
      metadata: opts.metadata ?? null,
    });
  // One channel for both dispatches: the default one also carries the provider's token usage,
  // a user-supplied `complete` returns text only (nothing to report, nothing invented).
  const call = async (msgs: JudgeMessage[]): Promise<JudgeCompletion> =>
    opts.complete === undefined
      ? defaultComplete(opts.model, msgs)
      : { text: await opts.complete(opts.model, msgs) };
  const judge: Scorer = async (ctx: ScorerContext): Promise<Score> => {
    const rendered = builder
      ? renderBuilt(messages, await builder(ctx), ctx, opts.name)
      : renderMessages(messages, ctx);
    // If a provider integration already traces this model's calls, let IT own the LLM span
    // (richer: native semantics) instead of adding our own — otherwise we'd nest an LLM span
    // inside an LLM span. This only holds for the DEFAULT dispatch: a user-supplied `complete`
    // is not provider-instrumented, so we must self-instrument it regardless of the model id.
    // Mirror observe()'s lazy init BEFORE checking provider wiring: a provider integration only
    // registers on the first TraceRoot.initialize(), so checking earlier would run before wiring
    // and self-instrument a default-dispatch call the integration also traces (nested LLM spans).
    if (opts.complete === undefined && !TraceRoot.isInitialized()) TraceRoot.initialize();
    const providerTraced = opts.complete === undefined && providerIntegrationTraces(opts.model);
    const text = providerTraced
      ? (await call(rendered)).text
      : await observe(
          // rendered messages are the span input, the model's response the output, type = llm.
          { name: `llm_judge:${opts.name}`, type: 'llm', metadata: { model: opts.model } },
          async (msgs: JudgeMessage[]) => {
            const completion = await call(msgs);
            // Inside observe(), the active span IS the judge's own LLM span. Recording the
            // provider's token counts there is what lets the backend price this call: on the
            // integration-traced path above we add no span at all, so the integration's own
            // token attributes remain the only ones (never two spans for one request).
            if (completion.usage) setJudgeTokenCounts(completion.usage);
            return completion.text;
          },
          rendered,
        );
    return {
      name: opts.name,
      value: parseJudgeOutput(text ?? '', outputType),
      comment: (text ?? '').slice(0, 2000),
      metadata: null,
      version: opts.version ?? null,
    };
  };
  Object.defineProperty(judge, 'name', { value: opts.name, configurable: true });
  const meta: ScorerMeta = {
    name: opts.name,
    scorerType: 'llm_judge',
    model: opts.model,
    messages,
    outputType,
    version: resolvedVersion, // the declarative config hash (or an explicit version)
  };
  if (opts.key !== undefined) meta.key = opts.key;
  // Dynamic judge: capture the builder-callback provenance (source string; honest fallback under
  // minification). A static judge records none — its config-hash version is its source.
  if (builder) (meta as unknown as Record<string, unknown>).builderSource = String(builder);
  if (opts.threshold !== undefined) meta.threshold = opts.threshold;
  if (opts.description !== undefined) meta.description = opts.description;
  if (opts.metadata !== undefined) meta.metadata = opts.metadata;
  if (opts.direction !== undefined) meta.direction = opts.direction;
  if (opts.valueType !== undefined) meta.valueType = opts.valueType;
  if (requiredInputs !== undefined) meta.requiredInputs = requiredInputs;
  (judge as any)[META] = meta;
  return judge;
}

/**
 * Unified scorer-definition namespace with NAMED constructors (stronger types + autocomplete than one
 * `Scorer(type=...)` constructor whose options mostly wouldn't apply):
 *   - `Scorer.code(opts, fn)`       — a code scorer (an ordinary function also works with NO wrapper).
 *   - `Scorer.llmJudge(opts)`       — a static LLM judge (declarative config only; no function).
 *   - `Scorer.llmJudge(opts, fn)`   — a dynamic LLM judge (the builder returns the judge's template
 *                                     variables or messages per case).
 * `kind` (`code` | `llm_judge`) stays internal on the normalized definition. `Scorer` is the
 * executable definition + policy + provenance; `Score` (separate) is one emitted result per case.
 */
export const Scorer = {
  code(opts: ScorerMeta, fn: Scorer): Scorer {
    return scorer(fn, opts);
  },
  llmJudge(opts: LlmJudgeOptions, builder?: JudgeBuilder): Scorer {
    return llmJudge(opts, builder);
  },
};
