import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeJsonTruncate } from './json.ts';

test('returns short strings unchanged', () => {
  assert.equal(safeJsonTruncate('hello', 2048), 'hello');
});

test('stringifies objects', () => {
  assert.equal(safeJsonTruncate({ a: 1 }, 2048), '{"a":1}');
});

test('truncates and appends an ellipsis when over the limit', () => {
  const out = safeJsonTruncate('abcdef', 3);
  assert.equal(out, 'abc…');
});

test('returns empty string for undefined', () => {
  assert.equal(safeJsonTruncate(undefined, 2048), '');
});

test('returns a marker for unserializable values (cycles)', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(safeJsonTruncate(cyclic, 2048), '[unserializable]');
});

test('returns empty string when maxChars is zero', () => {
  assert.equal(safeJsonTruncate('abc', 0), '');
});
