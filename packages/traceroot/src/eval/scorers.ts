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

/**
 * Whether an active provider integration already traces this model's calls, so the judge must
 * NOT add its own LLM span (an LLM span nested inside an LLM span is redundant). The provider is
 * inferred from the model id the same way defaultComplete dispatches.
 */

export const VALUE_TYPES = ['numeric', 'boolean', 'categorical'] as const;
export const DIRECTIONS = ['higher_is_better', 'lower_is_better', 'none'] as const;
export const OUTPUT_TYPES = ['score', 'classification'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];
export type Direction = (typeof DIRECTIONS)[number];
export type OutputType = (typeof OUTPUT_TYPES)[number];
export type ScorerType = 'code' | 'llm_judge';

export type ScoreLikeReturn =
  | number
  | boolean
  | string
  | Score
  | Score[]
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
  const vtype = declared(fn, 'valueType') ?? valueTypeHint ?? null;
  let direction = declared(fn, 'direction') ?? null;
  if (direction === null && vtype !== null) {
    direction = vtype === 'categorical' ? 'none' : 'higher_is_better';
  }
  const scorerType: ScorerType = declared(fn, 'scorerType') ?? 'code';
  let outputType: OutputType | null = declared(fn, 'outputType') ?? null;
  if (outputType === null && vtype !== null) {
    outputType = vtype === 'categorical' ? 'classification' : 'score';
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

/**
 * A first-class LLM-judge scorer: its `model` + `messages` (authored template) are carried
 * as the reported definition; calling it renders {{input}}/{{output}}/{{expected}} per case
 * and runs the model. Parity with Python `llm_judge`.
 */
