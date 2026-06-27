import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpanState } from '../state.ts';
import { raceWithTimeout, registerSession } from './session.ts';
import type { Runtime } from '../runtime.ts';
import { fakeRuntime, fire, UI_CTX } from '../test-support.ts';

// ---------------------------------------------------------------------------
// session_start — fork/resume linkage isolation
// ---------------------------------------------------------------------------

test('session_start clears stale fork/resume linkage from a reused instance', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.forkLink = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
  rt.state.forkedFromSessionFile = '/old/session.jsonl';
  rt.state.resumeFrom = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) };
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.forkLink, null);
  assert.equal(rt.state.forkedFromSessionFile, null);
  assert.equal(rt.state.resumeFrom, null);
});

test('a fork captured by one session does not leak into a later new session', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  await fire(
    handlers,
    'session_start',
    { reason: 'fork', previousSessionFile: '/parent.jsonl' },
    UI_CTX,
  );
  assert.equal(rt.state.forkedFromSessionFile, '/parent.jsonl');
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.forkedFromSessionFile, null);
  assert.equal(rt.state.forkLink, null);
});

// ---------------------------------------------------------------------------
// session_start — per-session state reset across a reused instance
// ---------------------------------------------------------------------------

test('a new session_start clears per-session state from a reused instance', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.promptIndex = 3;
  rt.state.currentModel = { provider: 'openai', id: 'gpt-4o' };
  rt.state.lastAssistantText = 'leftover from the prior session';
  rt.state.projectFinalized = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.promptIndex, 0, 'turn numbering restarts');
  assert.equal(rt.state.currentModel, null, 'stale model cleared');
  assert.equal(rt.state.lastAssistantText, null, 'stale output cleared');
  assert.equal(
    rt.state.projectFinalized,
    false,
    'project-local config is re-read for the new session',
  );
});

test('a new session re-enables tracing (disable is scoped per-session)', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.sessionDisabled = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(rt.state.sessionDisabled, false, 'a new session starts with tracing enabled');
});

test('providerShutdown is process-scoped and survives a new session', async () => {
  const { rt, handlers } = fakeRuntime();
  registerSession(rt);
  rt.state.providerShutdown = true;
  await fire(handlers, 'session_start', { reason: 'new' }, UI_CTX);
  assert.equal(
    rt.state.providerShutdown,
    true,
    'providerShutdown must not be reset across sessions',
  );
});

// ---------------------------------------------------------------------------
// session_shutdown — provider lifecycle (flush always; shutdown only on quit)
// ---------------------------------------------------------------------------

test('a reload session_shutdown flushes but keeps the shared provider alive', async () => {
  const { rt, handlers, providerCalls } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'reload' }, UI_CTX);
  assert.equal(providerCalls.shutdown, 0, 'reload is a session transition, not a terminal quit');
  assert.ok(providerCalls.flush >= 1, 'spans are still flushed across a reload');
  assert.equal(
    rt.state.providerShutdown,
    false,
    'the provider remains usable for the reloaded session',
  );
});

test('a quit session_shutdown shuts the provider down exactly once', async () => {
  const { rt, handlers, providerCalls } = fakeRuntime();
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  assert.equal(providerCalls.shutdown, 1, 'quit is terminal');
  assert.equal(rt.state.providerShutdown, true);
});

test('a rejecting shutdown on quit still marks providerShutdown and does not throw', async () => {
  const { rt, handlers, providerCalls } = fakeRuntime();
  (rt.provider as unknown as { shutdown: () => Promise<void> }).shutdown = async () => {
    throw new Error('shutdown failed');
  };
  registerSession(rt);
  await fire(handlers, 'session_shutdown', { reason: 'quit' }, UI_CTX);
  assert.equal(
    rt.state.providerShutdown,
    true,
    'providerShutdown is set even when shutdown rejects',
  );
  assert.equal(providerCalls.flush, 1, 'the flush still ran');
});

test('session_shutdown logs the real flush outcome instead of a blanket "flushed"', async () => {
  const debugLines: string[] = [];
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const rt = {
    pi: { on: (e: string, h: (raw: unknown, ctx?: unknown) => unknown) => handlers.set(e, h) },
    state: createSpanState(),
    config: {},
    provider: {
      forceFlush: async () => {
        throw new Error('backend down');
      },
      shutdown: async () => {},
    },
    debug: (...args: unknown[]) => debugLines.push(args.map(String).join(' ')),
  } as unknown as Runtime;
  registerSession(rt);
  const handler = handlers.get('session_shutdown');
  assert.ok(handler, 'session_shutdown handler registered');
  await handler({ reason: 'reload' }, UI_CTX);
  assert.ok(
    debugLines.some((l) => l.includes('error')),
    'a failed flush is logged as error, not silently as flushed',
  );
});

// ---------------------------------------------------------------------------
// raceWithTimeout — the bounded, non-blocking timeout helper
// ---------------------------------------------------------------------------

test('raceWithTimeout resolves to "timeout" when the work does not settle in time', async () => {
  const never = new Promise<string>(() => {});
  assert.equal(await raceWithTimeout(never, 5), 'timeout');
});

test('raceWithTimeout resolves to the work value when it settles before the deadline', async () => {
  assert.equal(await raceWithTimeout(Promise.resolve('done'), 1000), 'done');
});
