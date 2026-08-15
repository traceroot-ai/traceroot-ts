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

import type { ScorerContext, Score, DeferredScore } from './types';
import { observe } from '../observe';
import { isProviderInstrumented } from '../instrumentation';
import { TraceRoot } from '../traceroot';

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

function fnName(fn: Scorer): string {
  return fn.name && fn.name.length > 0 ? fn.name : 'scorer';
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
  const name = declared(fn, 'name') ?? fnName(fn);
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
  return scorers.map((s) => scorerMetadata(s, valueTypes[declared(s, 'name') ?? fnName(s)]));
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

async function defaultComplete(model: string, messages: JudgeMessage[]): Promise<string> {
  const pkg =
    model.startsWith('claude') || model.startsWith('anthropic') ? '@anthropic-ai/sdk' : 'openai';
  let mod: any;
  try {
    mod = await import(pkg);
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
    return (resp.content ?? []).map((b: any) => b.text ?? '').join('');
  }
  const client = new mod.default();
  const resp = await client.chat.completions.create({ model, messages });
  return resp.choices[0]?.message?.content ?? '';
}

export interface LlmJudgeOptions {
  name: string;
  model: string;
  messages: JudgeMessage[];
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
export function llmJudge(opts: LlmJudgeOptions): Scorer {
  const outputType: OutputType = opts.outputType ?? 'score';
  if (!OUTPUT_TYPES.includes(outputType)) {
    throw new Error(`outputType must be one of ${OUTPUT_TYPES.join(', ')}, got ${outputType}`);
  }
  const requiredInputs =
    opts.requiredInputs !== undefined ? validateRequiredInputs(opts.requiredInputs) : undefined;
  const call = (msgs: JudgeMessage[]) => (opts.complete ?? defaultComplete)(opts.model, msgs);
  const judge: Scorer = async (ctx: ScorerContext): Promise<Score> => {
    const rendered = renderMessages(opts.messages, ctx);
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
      ? await call(rendered)
      : await observe(
          // rendered messages are the span input, the model's response the output, type = llm.
          { name: `llm_judge:${opts.name}`, type: 'llm', metadata: { model: opts.model } },
          call,
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
    messages: opts.messages,
    outputType,
  };
  if (opts.version !== undefined) meta.version = opts.version;
  if (opts.threshold !== undefined) meta.threshold = opts.threshold;
  if (opts.description !== undefined) meta.description = opts.description;
  if (opts.metadata !== undefined) meta.metadata = opts.metadata;
  if (opts.direction !== undefined) meta.direction = opts.direction;
  if (opts.valueType !== undefined) meta.valueType = opts.valueType;
  if (requiredInputs !== undefined) meta.requiredInputs = requiredInputs;
  (judge as any)[META] = meta;
  return judge;
}
