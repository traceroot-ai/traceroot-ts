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
  const byJson = (a: unknown, b: unknown): number => {
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  };
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    // Cycle detection tracks only the ACTIVE recursion path: a true cycle (an ancestor) collapses
    // to null, but a merely repeated/aliased reference must still hash as its full content (so an
    // aliased object and an equivalent clone produce the same revision). We therefore delete `v`
    // from `seen` when its branch ends (below), rather than leaving it marked forever.
    if (seen.has(v as object)) return null;
    // Non-plain objects have no own enumerable keys, so the generic record path would collapse them
    // to `{}` and make distinct values hash identically. Canonicalize the supported built-ins by a
    // content-bearing form; Date is a leaf (no recursion).
    if (v instanceof Date) {
      return `@date:${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()}`;
    }
    seen.add(v as object);
    try {
      if (typeof (v as { toJSON?: unknown }).toJSON === 'function') {
        return norm((v as { toJSON: () => unknown }).toJSON());
      }
      if (v instanceof Map) {
        // Unordered: sort normalized entries so different contents differ and order doesn't.
        return { '@map': [...v.entries()].map(([k, val]) => [norm(k), norm(val)]).sort(byJson) };
      }
      if (v instanceof Set) {
        return { '@set': [...v].map(norm).sort(byJson) };
      }
      if (ArrayBuffer.isView(v)) {
        return { '@bytes': Array.from(v as unknown as ArrayLike<number>) };
      }
      if (Array.isArray(v)) return v.map(norm);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = norm((v as Record<string, unknown>)[k]);
      }
      return out;
    } finally {
      seen.delete(v as object);
    }
  };
  return JSON.stringify(norm(value));
}

/** Clone a case for a snapshot. `structuredClone` is a LOSSLESS deep copy for every value a
 *  dataset case should hold (primitives, plain objects/arrays, Date, Map/Set, typed arrays, nested
 *  and cyclic graphs), giving full isolation. It only throws on values that aren't valid case data
 *  (functions, symbols, unclonable class instances) — we reject those explicitly rather than fall
 *  back to a lossy JSON copy that would silently drop/convert fields and publish an incomplete case. */
function snapshotClone<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch (err) {
    throw new Error(
      `dataset case payload is not snapshottable (not structured-cloneable): ${
        err instanceof Error ? err.message : String(err)
      }. Snapshots require plain data — remove functions/symbols/non-cloneable objects from the case.`,
    );
  }
}

/** Recursively freeze a value so a snapshot cannot be mutated after capture. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
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
export interface DatasetSnapshot {
  datasetId: string;
  name: string;
  description: string | null;
  revision: string;
  cases: EvalCase[];
  baseVersionId: string | null;
}

/**
 * A local, mutable, ordered collection of {@link EvalCase} keyed by stable id. Construction
 * and mutation perform no network I/O. A client-generated `datasetId` (ds_+ULID) is
 * assigned at creation; `datasetVersionId` is set only when this mirrors a pushed/pulled
 * remote version.
 */
export class Dataset {
  name: string;
  description: string | null;
  datasetId: string;
  datasetVersionId?: string;
  baseVersionId: string | null = null;
  private readonly casesById = new Map<string, EvalCase>();

  constructor(name: string, description: string | null = null) {
    this.name = name;
    this.description = description;
    this.datasetId = newDatasetId();
  }

  // --- authoring / mutation (network-free) ---
  add(
    input: unknown,
    opts: {
      expected?: unknown;
      metadata?: Record<string, unknown> | null;
      sourceTraceId?: string;
      sourceSpanId?: string;
      id?: string;
    } = {},
  ): EvalCase {
    const cid = opts.id ?? newTestCaseId();
    if (this.casesById.has(cid)) throw new Error(`test case id already exists: ${cid}`);
    const c: EvalCase = {
      input,
      id: cid,
      expected: opts.expected,
      metadata: opts.metadata,
      sourceTraceId: opts.sourceTraceId,
      sourceSpanId: opts.sourceSpanId,
    };
    this.casesById.set(cid, c);
    return c;
  }

  /** Add or replace by id; anonymous cases get a stable ULID id. */
  upsert(evalCase: EvalCase): EvalCase {
    const stored = evalCase.id == null ? { ...evalCase, id: newTestCaseId() } : evalCase;
    this.casesById.set(stored.id as string, stored);
    return stored;
  }

  /** Replace fields of an existing case; throws if absent. */
  update(id: string, changes: Partial<EvalCase>): EvalCase {
    const cur = this.casesById.get(id);
    if (!cur) throw new Error(`no such case: ${id}`);
    const updated = { ...cur, ...changes, id };
    this.casesById.set(id, updated);
    return updated;
  }

  /** Soft-archive a case: retained for lineage, excluded from the active set. */
  archive(id: string): void {
    const cur = this.casesById.get(id);
    if (!cur) throw new Error(`no such case: ${id}`);
    this.casesById.set(id, { ...cur, archived: true });
  }

  /** Hard-delete a case; throws if absent. */
  remove(id: string): void {
    if (!this.casesById.delete(id)) throw new Error(`no such case: ${id}`);
  }

  // --- access ---
  get(id: string): EvalCase | undefined {
    return this.casesById.get(id);
  }

  cases(includeArchived = false): EvalCase[] {
    return [...this.casesById.values()].filter((c) => includeArchived || !c.archived);
  }

  get size(): number {
    return this.cases().length;
  }

  [Symbol.iterator](): Iterator<EvalCase> {
    return this.cases()[Symbol.iterator]();
  }

  // --- snapshot ---
  snapshot(): DatasetSnapshot {
    const active = this.cases();
    // Deep-copy + freeze so the snapshot is a stable, content-addressed record: later mutation
    // of the dataset's live case objects can no longer change what this revision describes, and
    // the snapshot itself cannot be edited after capture.
    const frozen = active.map((c) => deepFreeze(snapshotClone(c)));
    return Object.freeze({
      datasetId: this.datasetId,
      name: this.name,
      description: this.description,
      revision: contentRevision(active),
      cases: frozen,
      baseVersionId: this.baseVersionId,
    });
  }

  // --- serialization (network-free) ---
  toJSON(): {
    datasetId: string;
    name: string;
    description: string | null;
    baseVersionId: string | null;
    cases: EvalCase[];
  } {
    return {
      datasetId: this.datasetId,
      name: this.name,
      description: this.description,
      baseVersionId: this.baseVersionId,
      cases: [...this.casesById.values()], // incl. archived
    };
  }

  static fromJSON(d: {
    name: string;
    description?: string | null;
    datasetId?: string;
    baseVersionId?: string | null;
    datasetVersionId?: string;
    cases?: EvalCase[];
  }): Dataset {
    const ds = new Dataset(d.name, d.description ?? null);
    if (d.datasetId) ds.datasetId = d.datasetId;
    ds.baseVersionId = d.baseVersionId ?? null;
    ds.datasetVersionId = d.datasetVersionId;
    for (const c of d.cases ?? []) ds.casesById.set(c.id as string, c);
    return ds;
  }

  /** Write to disk. `.jsonl` = header line + one line per case; else `.json`. */
  save(path: string): void {
    if (path.endsWith('.jsonl')) {
      const header = {
        type: 'dataset',
        datasetId: this.datasetId,
        name: this.name,
        description: this.description,
        baseVersionId: this.baseVersionId,
        schema: 1,
      };
      const lines = [JSON.stringify(header)];
      for (const c of this.casesById.values()) lines.push(JSON.stringify({ type: 'case', ...c }));
      writeFileSync(path, lines.join('\n') + '\n');
    } else {
      writeFileSync(path, JSON.stringify(this.toJSON()));
    }
  }

  static load(path: string): Dataset {
    const text = readFileSync(path, 'utf8');
    if (path.endsWith('.jsonl')) {
      const records = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const header = records[0];
      return Dataset.fromJSON({
        datasetId: header.datasetId,
        name: header.name,
        description: header.description,
        baseVersionId: header.baseVersionId,
        cases: records.slice(1).map((r) => {
          const { type: _t, ...rest } = r;
          return rest as EvalCase;
        }),
      });
    }
    return Dataset.fromJSON(JSON.parse(text));
  }

  /**
   * Explicitly publish this dataset as ONE immutable server version. Local mutations never
   * create versions; this is the deliberate publish boundary. `transport` defaults to a
   * no-op LocalDatasetSync (local-only). `baseVersionId` (defaults to the pinned version)
   * drives optimistic concurrency; a stale base rejects with DatasetConflictError.
   */
  async push(
    transport?: import('./dataset_sync').DatasetSyncTransport,
    baseVersionId?: string | null,
  ): Promise<import('./dataset_sync').PushResult> {
    const { LocalDatasetSync } = await import('./dataset_sync');
    const sync = transport ?? new LocalDatasetSync();
    const snapshot = this.snapshot();
    const base = baseVersionId !== undefined ? baseVersionId : this.baseVersionId;
    const result = await sync.pushDataset(snapshot, base);
    if (result.status === 'uploaded' && result.datasetVersionId != null) {
      this.datasetVersionId = result.datasetVersionId;
      this.baseVersionId = result.datasetVersionId;
    }
    return result;
  }
}
