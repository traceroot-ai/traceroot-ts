import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSpanId, isTraceId } from './hex.ts';

test('isTraceId accepts 32 lowercase hex chars only', () => {
  assert.equal(isTraceId('a'.repeat(32)), true);
  assert.equal(isTraceId('0123456789abcdef0123456789abcdef'), true);
  assert.equal(isTraceId('A'.repeat(32)), false); // uppercase
  assert.equal(isTraceId('a'.repeat(31)), false); // too short
  assert.equal(isTraceId('a'.repeat(33)), false); // too long
  assert.equal(isTraceId('g'.repeat(32)), false); // non-hex
  assert.equal(isTraceId(undefined), false);
  assert.equal(isTraceId(null), false);
});

test('isSpanId accepts 16 lowercase hex chars only', () => {
  assert.equal(isSpanId('b'.repeat(16)), true);
  assert.equal(isSpanId('b'.repeat(15)), false);
  assert.equal(isSpanId('b'.repeat(17)), false);
  assert.equal(isSpanId('B'.repeat(16)), false);
  assert.equal(isSpanId(''), false);
});

test('rejects the all-zero "invalid" sentinel ids (W3C Trace Context)', () => {
  assert.equal(isTraceId('0'.repeat(32)), false, 'all-zero trace id is invalid');
  assert.equal(isSpanId('0'.repeat(16)), false, 'all-zero span id is invalid');
  // A single non-zero hex digit makes it valid again.
  assert.equal(isTraceId('0'.repeat(31) + '1'), true);
  assert.equal(isSpanId('1' + '0'.repeat(15)), true);
});
