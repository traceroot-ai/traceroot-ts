// src/eval/ids.ts — client-generated stable identifiers (parity with
// traceroot-py/traceroot/eval/ids.py).
//
// ULID: 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32
// (26 chars, time-sortable). Datasets/cases/runs get typed prefixes (ds_/tc_/run_) so the
// SDK can start local work without a server round-trip; the server accepts them idempotently.

import { randomBytes } from 'node:crypto';

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
