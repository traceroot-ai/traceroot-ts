import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { createSpanState } from '../state.ts';
import { registerSession } from './session.ts';
import type { Runtime } from '../runtime.ts';

function fakeRuntime() {
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const pi = {
    on: (event: string, h: (raw: unknown, ctx?: unknown) => unknown) => handlers.set(event, h),
  };
  const rt = {
    pi,
    state: createSpanState(),
    provider: {},
    config: { stateDir: tmpdir() },
    debug: () => {},
  } as unknown as Runtime;
  return { rt, handlers };
}

test('session_start clears stale fork/resume linkage from a reused instance', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  const sessionStart = handlers.get('session_start');
  if (!sessionStart) throw new Error('session_start handler not registered');

  // Seed linkage as if a prior fork/resume session had run in this instance.
  rt.state.forkLink = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
  rt.state.forkedFromSessionFile = '/old/session.jsonl';
  rt.state.resumeFrom = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) };

  await sessionStart({ reason: 'new' }, {});

  assert.equal(rt.state.forkLink, null);
  assert.equal(rt.state.forkedFromSessionFile, null);
  assert.equal(rt.state.resumeFrom, null);
});

test('a fork captured by one session does not leak into a later new session', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  const sessionStart = handlers.get('session_start');
  if (!sessionStart) throw new Error('session_start handler not registered');

  // First session forks from a parent.
  await sessionStart({ reason: 'fork', previousSessionFile: '/parent.jsonl' }, {});
  assert.equal(rt.state.forkedFromSessionFile, '/parent.jsonl');

  // A subsequent new session in the same instance must not inherit it.
  await sessionStart({ reason: 'new' }, {});
  assert.equal(rt.state.forkedFromSessionFile, null);
  assert.equal(rt.state.forkLink, null);
});
