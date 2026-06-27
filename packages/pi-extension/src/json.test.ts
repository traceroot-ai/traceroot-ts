import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeJsonTruncate, safeSlice } from './json.ts';

test('returns short strings unchanged', () => {
  assert.equal(safeJsonTruncate('hello', 2048), 'hello');
});

// U+20000 is a supplementary-plane CJK ideograph: in UTF-16 it is a surrogate pair
// (two code units), which is what these tests exercise. Any astral character works;
// a non-emoji one is used deliberately.
const ASTRAL = '\u{20000}';

test('safeSlice does not split a surrogate pair at the truncation boundary', () => {
  // "ab" + an astral character (a surrogate pair, 2 code units). Cutting at 3 would
  // land between the high and low surrogate; safeSlice must drop the dangling high one.
  const value = `ab${ASTRAL}`;
  const sliced = safeSlice(value, 3);
  assert.equal(sliced, 'ab', 'the half character is dropped, not left as a lone surrogate');
  assert.ok(!/[\uD800-\uDBFF]$/.test(sliced), 'no trailing lone high surrogate');
});

test('safeSlice keeps a whole surrogate pair when it fits', () => {
  const value = `a${ASTRAL}b`;
  assert.equal(safeSlice(value, 3), `a${ASTRAL}`);
});

test('safeJsonTruncate never emits a trailing lone surrogate', () => {
  const value = 'x'.repeat(2047) + ASTRAL; // the surrogate pair starts at index 2047
  const out = safeJsonTruncate(value, 2048);
  assert.ok(
    !/[\uD800-\uDBFF]…?$/.test(out.replace(/…$/, '')),
    'no lone surrogate before the ellipsis',
  );
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
