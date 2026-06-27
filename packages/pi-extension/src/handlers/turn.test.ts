import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { registerTurn } from './turn.ts';
import { repoSlug } from '../attribution.ts';
import { fakeRuntime, fire, UI_CTX } from '../test-support.ts';

// ---------------------------------------------------------------------------
// before_agent_start / input — buffering
// ---------------------------------------------------------------------------

test('before_agent_start buffers the prompt for the next turn', async () => {
  const { rt, handlers } = fakeRuntime();
  registerTurn(rt);
  await fire(handlers, 'before_agent_start', { prompt: 'hello world' });
  assert.equal(rt.state.pendingPrompt, 'hello world');
});

// ---------------------------------------------------------------------------
// agent_start — opens the session + turn spans; input + raw-input privacy gate
// ---------------------------------------------------------------------------

test('agent_start opens a session span then a turn span, stamping the prompt and turn index', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  await fire(handlers, 'before_agent_start', { prompt: 'do the thing' });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.equal(spans[0]?.name, 'pi.session', 'session span opened lazily first');
  assert.equal(spans[1]?.name, 'pi.turn', 'then the turn span');
  assert.equal(spans[1]?.attrs['traceroot.pi.turn_index'], 0);
  assert.equal(spans[1]?.attrs['traceroot.span.input'], 'do the thing');
  assert.ok(rt.state.sessionSpan, 'session span is retained in state');
});

test('agent_start buffers input metadata onto the turn span and gates raw input off by default', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: false });
  registerTurn(rt);
  await fire(handlers, 'input', { source: 'interactive', text: 'my secret prompt', images: [] });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  const turn = spans[1];
  assert.ok(turn, 'a turn span was opened');
  assert.equal(
    turn.attrs['traceroot.pi.input_source'],
    'interactive',
    'input metadata is recorded',
  );
  assert.equal(
    turn.attrs['traceroot.pi.raw_input'],
    undefined,
    'raw user input is suppressed by default',
  );
});

test('agent_start records raw input only when captureFullPayload is on', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: true });
  registerTurn(rt);
  await fire(handlers, 'input', { source: 'interactive', text: 'my secret prompt' });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.ok(
    String(spans[1]?.attrs['traceroot.pi.raw_input'] ?? '').includes('my secret prompt'),
    'raw input is captured on opt-in',
  );
});

test('agent_start is skipped while the session is disabled (but still consumes the pending prompt)', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  rt.state.sessionDisabled = true;
  await fire(handlers, 'before_agent_start', { prompt: 'p' });
  await fire(handlers, 'agent_start', {}, UI_CTX);
  assert.equal(spans.length, 0, 'no spans opened while disabled');
  assert.equal(
    rt.state.pendingPrompt,
    null,
    'the pending prompt is consumed so it cannot stick to a later loop',
  );
});

// Going beyond: the repo slug is now attached asynchronously (off the hot path), so it
// lands on the session span after the git lookup settles — verify the end-to-end wiring.
test('agent_start attaches the repo slug to the session span asynchronously', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-turn-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], {
      cwd: dir,
    });
    const { rt, handlers, spans } = fakeRuntime();
    registerTurn(rt);
    await fire(handlers, 'agent_start', {}, { ...UI_CTX, cwd: dir });
    // The session span exists synchronously, but repo is resolved off the hot path.
    assert.equal(spans[0]?.name, 'pi.session');
    await repoSlug(dir); // same cached promise the handler awaited — wait for git to settle
    await new Promise((resolve) => setImmediate(resolve)); // flush the handler's then(setAttr)
    assert.equal(spans[0]?.attrs['traceroot.pi.repo'], 'acme/widgets');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// agent_end — closes the turn span, advances the counter, sweeps leftovers
// ---------------------------------------------------------------------------

test('agent_end ends the open turn span and advances the turn counter', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  const turnSpan = rt.tracer.startSpan('pi.turn'); // recorded as spans[0]
  rt.state.turnSpan = turnSpan;
  rt.state.turnCtx = ROOT_CONTEXT;
  rt.state.promptIndex = 2;
  await fire(handlers, 'agent_end', { messages: [] });
  assert.equal(spans[0]?.ended, true, 'the turn span is ended');
  assert.equal(rt.state.turnSpan, null, 'turn span reference cleared');
  assert.equal(rt.state.turnCtx, null, 'turn context reference cleared');
  assert.equal(rt.state.promptIndex, 3, 'the turn counter advances');
});

test('agent_end with no open turn span is a no-op', async () => {
  const { rt, handlers } = fakeRuntime();
  registerTurn(rt);
  rt.state.promptIndex = 0;
  await fire(handlers, 'agent_end', { messages: [] });
  assert.equal(rt.state.promptIndex, 0, 'no open turn span means the counter does not change');
});

test('a re-entrant agent_start closes the prior turn span before opening a new one', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTurn(rt);
  await fire(handlers, 'agent_start', {}, UI_CTX); // session[0] + turn[1]
  const firstTurn = spans[1];
  await fire(handlers, 'agent_start', {}, UI_CTX); // a second loop without an intervening agent_end
  assert.equal(firstTurn?.ended, true, 'the prior turn span is swept closed');
  assert.equal(spans[2]?.name, 'pi.turn', 'a fresh turn span is opened');
});
