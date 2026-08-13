// src/eval/canonical.ts — ONE canonical form for offline evaluation, used for BOTH hashing and
// the wire. Byte-identical with the Python `traceroot/eval/canonical.py`.
//
// Every dataset/case/scorer identity in the SDK flows through here, so a dataset authored in
// TypeScript and re-authored in Python reconciles to one identity on the platform.
//
// The grammar is JavaScript's, because JSON's number space is JavaScript's and only one of the
// two languages can be the reference:
//   * numbers render via `Number::toString` (what `String(n)` does), so `1.0` is `1`, `-0` is
//     `0`, `1e-5` is `0.00001` and `1e-7` is `1e-7`;
//   * object keys sort by Unicode CODE POINT (not UTF-16 code unit, which mis-sorts astral-plane
//     keys), and the JSON text is built directly from that sorted key list — never by assigning
//     into an object, which silently reorders integer-like keys ({"10":..,"2":..});
//   * `Date` renders as `toISOString()`;
//   * `Set` renders as an array sorted by each item's canonical JSON;
//   * `Uint8Array`/`ArrayBuffer` render as an array of byte integers;
//   * `NaN`/`Infinity`/`-Infinity` render as the string sentinels "NaN"/"Infinity"/"-Infinity"
//     (JSON has no such literals and both SDKs must agree on the substitute);
//   * anything else (class instances, functions, symbols, bigint) is REJECTED with an actionable
//     error rather than hashed in a language-specific shape.
//
// `normalize()` produces the value that is hashed AND the value put on the wire, so
// hash-form == wire-form == read-back-form and a pushed dataset's revision survives a round trip.

import { createHash } from 'node:crypto';

/** A value cannot be canonicalized (not JSON-serializable, or a reference cycle). */
export class CanonicalizationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

/** Compare two strings by Unicode CODE POINT. `Array.prototype.sort`'s default and `<` both
 *  compare UTF-16 code units, which orders an astral-plane character before U+E000..U+FFFF —
 *  the opposite of Python's ordering. */
export function compareCodePoints(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const pa = ca[i].codePointAt(0) as number;
    const pb = cb[i].codePointAt(0) as number;
    if (pa !== pb) return pa < pb ? -1 : 1;
  }
  return ca.length - cb.length;
}

// A lone UTF-16 surrogate: a high surrogate not followed by a low one, or a low one not preceded
// by a high one. Such a string is not valid Unicode text.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function rejectLoneSurrogate(s: string): void {
  // Parity with Python `_reject_lone_surrogate`: a lone surrogate cannot be encoded as UTF-8, so
  // Python would raise while hashing it and this SDK would silently hash the escaped form — the two
  // must agree, so reject it explicitly in both.
  if (LONE_SURROGATE.test(s)) {
    throw new CanonicalizationError(
      'string contains an unpaired UTF-16 surrogate and cannot be canonicalized; ' +
        'it is not valid Unicode text',
    );
  }
}

function reject(value: unknown): never {
  const kind =
    typeof value === 'object' && value !== null
      ? (value.constructor?.name ?? 'object')
      : typeof value;
  throw new CanonicalizationError(
    `value of type '${kind}' is not JSON-serializable; evaluation payloads must be built from ` +
      `null/boolean/number/string/array/plain object/Map/Set/Date/typed array (convert it ` +
      `yourself, e.g. structuredClone into a plain object or call your own toJSON)`,
  );
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Stringify a mapping key the way a JavaScript object/Map key stringifies. */
function normKey(k: unknown): string {
  if (typeof k === 'string') {
    rejectLoneSurrogate(k);
    return k;
  }
  if (typeof k === 'boolean') return k ? 'true' : 'false';
  if (typeof k === 'number') return numberToken(k);
  if (k === null || k === undefined) return 'null';
  throw new CanonicalizationError(
    `mapping key of type '${typeof k}' is not JSON-serializable; use a string, number, ` +
      `boolean, or null key`,
  );
}

function numberToken(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  return String(n); // Number::toString; String(-0) === '0'
}

function norm(value: unknown, path: object[]): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'boolean') return value;
  if (t === 'string') {
    rejectLoneSurrogate(value as string);
    return value;
  }
  if (t === 'number') {
    const n = value as number;
    if (Number.isNaN(n)) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    return n;
  }
  if (t !== 'object') reject(value); // function, symbol, bigint

  const obj = value as object;
  if (obj instanceof Date) {
    if (Number.isNaN(obj.getTime())) {
      throw new CanonicalizationError('an Invalid Date cannot be canonicalized');
    }
    return obj.toISOString();
  }
  if (ArrayBuffer.isView(obj)) {
    const bytes = new Uint8Array(
      (obj as ArrayBufferView).buffer,
      (obj as ArrayBufferView).byteOffset,
      (obj as ArrayBufferView).byteLength,
    );
    return Array.from(bytes);
  }
  if (obj instanceof ArrayBuffer) return Array.from(new Uint8Array(obj));

  // Track only the ACTIVE recursion path: a true cycle is an error, but a merely repeated
  // (aliased) reference must still canonicalize as its full content.
  if (path.includes(obj)) {
    throw new CanonicalizationError('value contains a reference cycle and cannot be canonicalized');
  }
  path.push(obj);
  try {
    if (Array.isArray(obj)) return obj.map((v) => norm(v, path));
    if (obj instanceof Set) {
      // Unordered: emit a deterministic array ordered by each item's canonical JSON.
      return [...obj].map((v) => norm(v, path)).sort((a, b) => compareCodePoints(dump(a), dump(b)));
    }
    if (obj instanceof Map) return normEntries([...obj.entries()], path);
    if (isPlainObject(obj)) {
      return normEntries(Object.entries(obj as Record<string, unknown>), path);
    }
    return reject(obj);
  } finally {
    path.pop();
  }
}

function normEntries(entries: [unknown, unknown][], path: object[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    const ks = normKey(k);
    if (Object.prototype.hasOwnProperty.call(out, ks)) {
      throw new CanonicalizationError(
        `mapping has two keys that stringify to ${JSON.stringify(ks)}; canonical JSON ` +
          `cannot represent both`,
      );
    }
    out[ks] = norm(v, path);
  }
  return out;
}

/** Canonical plain-JSON form of `value` — what gets hashed AND what goes on the wire. */
export function normalize(value: unknown): unknown {
  return norm(value, []);
}

/** Serialize an ALREADY-normalized value to canonical JSON text. */
function dump(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') return numberToken(value as number);
  if (Array.isArray(value)) return '[' + value.map(dump).join(',') + ']';
  const rec = value as Record<string, unknown>;
  // Keys are already strings. Sorting them explicitly by code point and emitting the text from
  // that list is what keeps `{"10":..,"2":..}` in Python's order: `Object.keys` would hand back
  // integer-like keys in ascending NUMERIC order first, defeating any later sort of the object.
  const keys = Object.keys(rec).sort(compareCodePoints);
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + dump(rec[k])).join(',') + '}';
}

/** Canonical JSON text for `value` (sorted keys, no whitespace, UTF-8). */
export function canonicalJson(value: unknown): string {
  return dump(normalize(value));
}

/** sha256 of the canonical JSON of `value`, truncated to `length` hex chars. */
export function canonicalHash(value: unknown, length: number): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, length);
}
