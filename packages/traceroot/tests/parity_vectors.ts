// Decoder for the shared cross-SDK parity fixtures.
//
// `case_id_parity.json` is byte-identical in traceroot-ts and traceroot-py, so its vectors have to
// be expressible in plain JSON — but the values that actually diverged between the SDKs (Dates,
// NaN/Infinity, Sets, bytes, Maps) have no JSON literal. The fixture encodes those in a tagged form
// that each suite decodes to its own native value before feeding the SDK. The tags exist ONLY in
// the fixture; the canonicalizer never sees them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(__dirname, 'fixtures');

export interface CaseVector {
  _comment: string;
  input: unknown;
  id: string;
  canonical_json: string;
}

export const CASE_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES, 'case_id_parity.json'), 'utf8'),
) as {
  dataset_key: string;
  dataset_id: string;
  revision: string;
  cases: CaseVector[];
};

export const SCORER_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES, 'scorer_definition_parity.json'), 'utf8'),
) as Record<string, Record<string, unknown>>;

/** Fixture encoding -> native JS value. Mirrors `decode` in tests/eval/parity_vectors.py. */
export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('$nan' in o) return NaN;
    if ('$inf' in o) return (o.$inf as number) > 0 ? Infinity : -Infinity;
    if ('$date' in o) return new Date(o.$date as string);
    if ('$set' in o) return new Set((o.$set as unknown[]).map(decode));
    if ('$bytes' in o) return Uint8Array.from(o.$bytes as number[]);
    if ('$map' in o) {
      return new Map((o.$map as [unknown, unknown][]).map(([k, v]) => [decode(k), decode(v)]));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = decode(v);
    return out;
  }
  return value;
}
