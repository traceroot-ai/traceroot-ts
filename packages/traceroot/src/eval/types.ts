// src/eval/types.ts — core data types for offline evaluation.
// Parity with traceroot-py/traceroot/eval/types.py. Local-first: construction, mutation,
// snapshotting, and serialization perform NO network I/O.

import { readFileSync, writeFileSync } from 'node:fs';

import {
  CanonicalizationError,
  canonicalHash,
  canonicalJson,
  compareCodePoints,
  normalize,
} from './canonical';
import { stableCaseId, stableDatasetId } from './ids';

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
// [EvalCase field, wire/hash key]. The hash key is snake_case so the content revision is
// byte-identical to Python's `_content_revision` (which hashes snake_case attribute names).
//
// Every field here MUST also travel on the wire and come back on a pull — a field that is hashed
// but not stored makes the published revision permanently unequal to the local one, so every push
// publishes a no-change version. `scoreTargetSpanId` is a reserved hook that the platform does not
// persist yet, so it is deliberately NOT part of the identity.
const CONTENT_FIELDS: [keyof EvalCase, string][] = [
  ['id', 'id'],
  ['input', 'input'],
  ['expected', 'expected'],
  ['metadata', 'metadata'],
  ['sourceTraceId', 'source_trace_id'],
  ['sourceSpanId', 'source_span_id'],
];

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

/** Recursively freeze a value so a snapshot cannot be mutated after capture. Cycle-aware (a
 *  structuredClone'd graph may be cyclic) and tolerant of built-ins: typed arrays throw on
 *  Object.freeze when populated, so they're left as-is (the clone already isolated them). */
function deepFreeze<T>(o: T, seen: WeakSet<object> = new WeakSet()): T {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o;
  if (seen.has(o as object)) return o; // already on the active path -> cycle
  seen.add(o as object);
  if (ArrayBuffer.isView(o)) return o; // freezing a populated typed array throws
  if (o instanceof Map) {
    for (const v of (o as Map<unknown, unknown>).values()) deepFreeze(v, seen);
  } else if (o instanceof Set) {
    for (const v of o as Set<unknown>) deepFreeze(v, seen);
  } else {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v, seen);
  }
  Object.freeze(o);
  return o;
}

export function contentRevision(cases: EvalCase[]): string {
  // Content-addressed and ORDER-INDEPENDENT: sort by id so re-authoring the same set of cases in a
  // different order yields the SAME revision (with content-based ids, reordering is not a content
  // change). Only a real content change advances the revision. Mirrors Python `_content_revision`.
  const ordered = [...cases].sort((a, b) => compareCodePoints(a.id ?? '', b.id ?? ''));
  const content = ordered.map((c) => {
    const o: Record<string, unknown> = {};
    for (const [field, key] of CONTENT_FIELDS) o[key] = c[field] ?? null;
    return o;
  });
  return `rev_${canonicalHash(content, 16)}`;
}

/** Reject a case payload the canonicalizer cannot represent, AT AUTHORING TIME.
 *
 *  Identity (case id + dataset revision) and the wire form are both the canonical form, so a value
 *  with no canonical form has no stable identity. Failing here names the offending field instead of
 *  surfacing as a mystery hash difference between the two SDKs later. */
function validatePayload(c: Pick<EvalCase, 'input' | 'expected' | 'metadata'>): void {
  for (const field of ['input', 'expected', 'metadata'] as const) {
    const value = c[field];
    if (value === undefined || value === null) continue;
    try {
      normalize(value);
    } catch (err) {
      if (err instanceof CanonicalizationError) {
        throw new CanonicalizationError(`test case ${field}: ${err.message}`);
      }
      throw err;
    }
  }
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
 * and mutation perform no network I/O. Identity is the dataset's `key` (defaults to `name`),
 * NOT which SDK or process created it: `datasetId` is a deterministic `ds_`+sha256 of the
 * key, so re-constructing the same dataset — another process, TypeScript or Python — yields
 * the SAME id and the platform converges their runs instead of forking a new dataset each
 * run. Pass an explicit `key` to keep identity stable across a display-name rename.
 * `datasetVersionId` is set only when this mirrors a pushed/pulled remote version; changed
 * content under the same key becomes a new VERSION.
 */
export class Dataset {
  name: string;
  description: string | null;
  key: string;
  datasetId: string;
  datasetVersionId?: string;
  baseVersionId: string | null = null;
  private readonly casesById = new Map<string, EvalCase>();

  constructor(name: string, description: string | null = null, opts: { key?: string } = {}) {
    this.name = name;
    this.description = description;
    this.key = opts.key ?? name;
    this.datasetId = stableDatasetId(this.key);
  }

  // --- authoring / mutation (network-free) ---
  /** The stable content id for `input`: dataset key + canonical input + first free occurrence.
   *  Shared by add() and upsert() so both converge on the same id. */
  private contentId(input: unknown): string {
    const canonical = canonicalJson(input);
    let occurrence = 0;
    let cid = stableCaseId(this.key, canonical, occurrence);
    while (this.casesById.has(cid)) {
      occurrence += 1;
      cid = stableCaseId(this.key, canonical, occurrence);
    }
    return cid;
  }

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
    // Without an explicit id, the case gets a STABLE id from the dataset key + its INPUT content
    // (not its position), so re-authoring converges (the platform matches by id) and inserting/
    // removing/reordering other cases does not shift this case's id. Duplicate inputs are
    // disambiguated by occurrence (the first free slot), collision-free across removes.
    validatePayload({ input, expected: opts.expected, metadata: opts.metadata });
    const cid = opts.id ? opts.id : this.contentId(input);
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

  /**
   * Add or replace by id.
   *
   * An anonymous case gets the SAME content-derived id add() would give it, not a fresh random
   * one: a random id would fork the case into a new server case on every process, which is
   * exactly what content-addressed ids exist to prevent.
   */
  upsert(evalCase: EvalCase): EvalCase {
    validatePayload(evalCase);
    const stored =
      evalCase.id == null ? { ...evalCase, id: this.contentId(evalCase.input) } : evalCase;
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
    key: string;
    description: string | null;
    baseVersionId: string | null;
    datasetVersionId: string | null;
    cases: EvalCase[];
  } {
    return {
      datasetId: this.datasetId,
      name: this.name,
      // The key is what every case id is derived from, so it must survive save/load: without it
      // a reloaded dataset falls back to `name` and every case added afterwards gets an id that
      // no longer converges with locally authored ones.
      key: this.key,
      description: this.description,
      baseVersionId: this.baseVersionId,
      // fromJSON reads this back, so dropping it here loses the remote binding — and evaluate()'s
      // auto-provision guard then re-pushes an already-synced dataset.
      datasetVersionId: this.datasetVersionId ?? null,
      cases: [...this.casesById.values()], // incl. archived
    };
  }

  static fromJSON(d: {
    name: string;
    key?: string | null;
    description?: string | null;
    datasetId?: string;
    baseVersionId?: string | null;
    datasetVersionId?: string | null;
    cases?: EvalCase[];
  }): Dataset {
    const ds = new Dataset(d.name, d.description ?? null, { key: d.key ?? undefined });
    if (d.datasetId) ds.datasetId = d.datasetId;
    ds.baseVersionId = d.baseVersionId ?? null;
    ds.datasetVersionId = d.datasetVersionId ?? undefined;
    // Anonymous cases (no id) each get a content id — otherwise every one keys on `undefined`
    // and all but the last silently collapse. Mirrors upsert().
    for (const c of d.cases ?? []) {
      const stored = c.id == null ? { ...c, id: ds.contentId(c.input) } : c;
      ds.casesById.set(stored.id as string, stored);
    }
    return ds;
  }

  /** Write to disk. `.jsonl` = header line + one line per case; else `.json`. */
  save(path: string): void {
    if (path.endsWith('.jsonl')) {
      const header = {
        type: 'dataset',
        datasetId: this.datasetId,
        name: this.name,
        key: this.key,
        description: this.description,
        baseVersionId: this.baseVersionId,
        datasetVersionId: this.datasetVersionId ?? null,
        schema: 1,
      };
      // Serialize through the canonical form (not raw JSON.stringify) so a Date/Map/Set survives
      // save -> load as the SAME value the revision was computed over: a reloaded dataset must
      // keep its revision, exactly as a pulled one does.
      const lines = [JSON.stringify(normalize(header))];
      for (const c of this.casesById.values()) {
        lines.push(JSON.stringify(normalize({ type: 'case', ...c })));
      }
      writeFileSync(path, lines.join('\n') + '\n');
    } else {
      writeFileSync(path, JSON.stringify(normalize(this.toJSON())));
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
        key: header.key,
        description: header.description,
        baseVersionId: header.baseVersionId,
        datasetVersionId: header.datasetVersionId,
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
