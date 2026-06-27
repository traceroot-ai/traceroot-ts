import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Span } from '@opentelemetry/api';
import { addEvent, setAttr } from './attributes.ts';

interface Recorder {
  span: Span;
  attrs: Record<string, unknown>;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
}

function recorder(): Recorder {
  const attrs: Record<string, unknown> = {};
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const span = {
    setAttribute: (k: string, v: unknown) => {
      attrs[k] = v;
    },
    addEvent: (name: string, a: Record<string, unknown>) => {
      events.push({ name, attrs: a });
    },
  } as unknown as Span;
  return { span, attrs, events };
}

test('setAttr writes primitive values', () => {
  const r = recorder();
  setAttr(r.span, 'a', 'x');
  setAttr(r.span, 'b', 3);
  setAttr(r.span, 'c', false);
  assert.deepEqual(r.attrs, { a: 'x', b: 3, c: false });
});

test('setAttr drops null and undefined', () => {
  const r = recorder();
  setAttr(r.span, 'n', null);
  setAttr(r.span, 'u', undefined);
  assert.deepEqual(r.attrs, {});
});

test('addEvent strips null/undefined from the attribute bag', () => {
  const r = recorder();
  addEvent(r.span, 'evt', { kept: 1, dropped: undefined, also: null });
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0], { name: 'evt', attrs: { kept: 1 } });
});
