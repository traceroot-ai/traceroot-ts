// src/eval/types.ts — core data types for offline evaluation.
// Parity with traceroot-py/traceroot/eval/types.py. Local-first: construction, mutation,
// snapshotting, and serialization perform NO network I/O.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { newDatasetId, newTestCaseId } from './ids';

/**
 * A runnable test case. Only `input` is required. `expected` is always optional and is
 * never inferred from a source span. `sourceTraceId`/`sourceSpanId` are provenance only.
 * `scoreTargetSpanId` is a reserved hook. `archived` marks a case retained for lineage but
 * excluded from evaluation/snapshots.
 */
export interface EvalCase {
  input: unknown;
  id?: string;
  expected?: unknown;
  metadata?: Record<string, unknown> | null;
  sourceTraceId?: string;
  sourceSpanId?: string;
  scoreTargetSpanId?: string;
  archived?: boolean;
}

/** A single scorer result. `value` may be numeric, boolean, or categorical. */
export interface Score {
  name: string;
  value: number | boolean | string;
  comment?: string | null;
  metadata?: Record<string, unknown> | null;
  /** The scorer version when explicitly declared; null/undefined means unversioned
   *  (V1 never invents a "1" for a scorer that did not declare a version). */
  version?: string | null;
}

/**
 * A scorer's signal that a score needs later (e.g. human) review. Recorded as a pending
 * score — never coerced to a numeric zero. A case whose only score is deferred is
 * `not_scored`, distinct from a score of 0.
 */
export class DeferredScore {
  constructor(
    readonly name: string,
    readonly reason?: string | null,
  ) {}
}

/** The single object argument passed to every scorer. */
export interface ScorerContext {
  input: unknown;
  output: unknown;
  expected: unknown;
  metadata: Record<string, unknown> | null | undefined;
}

// Content fields that define a snapshot's identity (archived + volatile excluded).
const CONTENT_FIELDS: (keyof EvalCase)[] = [
  'id',
  'input',
  'expected',
  'metadata',
  'sourceTraceId',
  'sourceSpanId',
  'scoreTargetSpanId',
];

/** Deterministic JSON with sorted keys — canonical form for content hashing. */
function canonicalJson(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    // Mark the source object seen BEFORE expanding it, so a self-returning or mutually recursive
    // toJSON() (or a cyclic object graph) terminates instead of overflowing the stack.
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    // Non-plain objects have no own enumerable keys, so the generic record path below would
    // collapse them to `{}` and make distinct values (e.g. two different Dates) hash identically —
    // a changed case could then keep its old revision. Canonicalize the ones with a defined
    // serialization first: Dates by ISO instant, anything else exposing toJSON by its JSON form.
    if (v instanceof Date) {
      return `@date:${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()}`;
    }
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      return norm((v as { toJSON: () => unknown }).toJSON());
    }
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

export function contentRevision(cases: EvalCase[]): string {
  const content = cases.map((c) => {
    const o: Record<string, unknown> = {};
    for (const k of CONTENT_FIELDS) o[k] = c[k] ?? null;
    return o;
  });
  const hash = createHash('sha256').update(canonicalJson(content)).digest('hex').slice(0, 16);
  return `rev_${hash}`;
}

/** An immutable, content-addressed snapshot of a dataset's active cases. */

/**
 * A local, mutable, ordered collection of {@link EvalCase} keyed by stable id. Construction
 * and mutation perform no network I/O. A client-generated `datasetId` (ds_+ULID) is
 * assigned at creation; `datasetVersionId` is set only when this mirrors a pushed/pulled
 * remote version.
 */
