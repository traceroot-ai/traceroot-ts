import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trace } from '@opentelemetry/api';
import { remoteParentContext } from './remote-parent.ts';

const VALID_TRACE = 'a'.repeat(32);
const VALID_SPAN = 'b'.repeat(16);

test('builds a remote-parent context from well-formed ids', () => {
  const ctx = remoteParentContext(VALID_TRACE, VALID_SPAN);
  assert.ok(ctx, 'a context is returned for valid ids');
  const sc = trace.getSpanContext(ctx);
  assert.ok(sc, 'the context carries a span context');
  assert.equal(sc.traceId, VALID_TRACE);
  assert.equal(sc.spanId, VALID_SPAN);
  assert.equal(sc.isRemote, true, 'the parent is marked remote');
});

test('rejects malformed or missing ids by returning undefined (no corrupt span context)', () => {
  const cases: Array<[string | null | undefined, string | null | undefined, string]> = [
    [null, VALID_SPAN, 'null trace'],
    [VALID_TRACE, null, 'null span'],
    [undefined, VALID_SPAN, 'undefined trace'],
    ['', VALID_SPAN, 'empty trace'],
    [VALID_TRACE, '', 'empty span'],
    ['abc', VALID_SPAN, 'too-short trace'],
    [VALID_TRACE, 'abc', 'too-short span'],
    [VALID_TRACE.toUpperCase(), VALID_SPAN, 'uppercase trace (must be lowercase hex)'],
    [VALID_SPAN, VALID_TRACE, 'swapped lengths (16-hex trace, 32-hex span)'],
    ['z'.repeat(32), VALID_SPAN, 'non-hex trace'],
  ];
  for (const [traceId, spanId, desc] of cases) {
    assert.equal(remoteParentContext(traceId, spanId), undefined, `expected undefined for ${desc}`);
  }
});
