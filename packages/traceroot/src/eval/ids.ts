// src/eval/ids.ts — client-generated stable identifiers (parity with
// traceroot-py/traceroot/eval/ids.py).
//
// ULID: 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32
// (26 chars, time-sortable). Datasets/cases/runs get typed prefixes (ds_/tc_/run_) so the
// SDK can start local work without a server round-trip; the server accepts them idempotently.

import { createHash, randomBytes } from 'node:crypto';

// Crockford base32 (excludes I, L, O, U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value: bigint, length: number): string {
  const chars: string[] = [];
  let v = value;
  for (let i = 0; i < length; i++) {
    chars.push(CROCKFORD[Number(v & 0x1fn)]);
    v >>= 5n;
  }
  return chars.reverse().join('');
}

/** A 26-char Crockford base32 ULID (time-ordered, unique). */
export function ulid(): string {
  const ts = BigInt(Date.now()) & ((1n << 48n) - 1n);
  const rand = BigInt('0x' + randomBytes(10).toString('hex')); // 80 random bits
  return encode(ts, 10) + encode(rand, 16);
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export const newDatasetId = (): string => newId('ds');
export const newTestCaseId = (): string => newId('tc');
export const newRunId = (): string => newId('run');

/** Deterministic dataset id derived from a semantic key (`ds_`+sha256 prefix).
 *
 *  A dataset's identity is its key, NOT which SDK or process created it, so this is a pure
 *  function of `key`: the SAME key — in any process, in TypeScript or Python — yields the
 *  SAME clientDatasetId, which is how the platform converges runs of one logical dataset
 *  (upsert on (project, client_dataset_id)) instead of forking a new dataset each run. Must
 *  stay byte-for-byte identical to the Python `stable_dataset_id`. */
export function stableDatasetId(key: string): string {
  const digest = createHash('sha256').update(key, 'utf8').digest('hex');
  return `ds_${digest.slice(0, 26)}`;
}

/** Deterministic case id from the dataset key + insertion position.
 *
 *  Convergence needs case ids to be stable across runs, not random per construction: the
 *  same case authored in the same position — any process, TypeScript or Python — must get
 *  the SAME `tc_` id so the platform matches it on re-publish (upsert keys on id) instead of
 *  duplicating it, and so runs pair case-for-case. CONTENT-based (the case's canonical input),
 *  NOT positional: inserting/removing/reordering cases must not shift other cases' ids. `occurrence`
 *  disambiguates duplicate inputs (0, 1, ...). `inputCanonical` is the canonical-JSON of the input,
 *  so this stays byte-for-byte identical to the Python `stable_case_id`. */
export function stableCaseId(datasetKey: string, inputCanonical: string, occurrence = 0): string {
  const digest = createHash('sha256')
    .update(`${datasetKey}\x00${inputCanonical}\x00${occurrence}`, 'utf8')
    .digest('hex');
  return `tc_${digest.slice(0, 20)}`;
}
