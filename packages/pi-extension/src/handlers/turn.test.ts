import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import { createSpanState } from '../state.ts';
import { registerTurn } from './turn.ts';
import type { Runtime } from '../runtime.ts';

function fakeTurnSpan(): { span: Span; ended: () => boolean } {
  let ended = false;
  const span = {
    setAttribute() {
      return span;
    },
    end() {
      ended = true;
    },
  } as unknown as Span;
  return { span, ended: () => ended };
}

function setup() {
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const rt = {
    pi: {
      on: (event: string, handler: (raw: unknown, ctx?: unknown) => unknown) =>
        handlers.set(event, handler),
    },
    state: createSpanState(),
    config: { captureFullPayload: false },
    debug: () => {},
  } as unknown as Runtime;
  return { rt, handlers };
}

async function fire(
  handlers: Map<string, (raw: unknown, ctx?: unknown) => unknown>,
  name: string,
  raw: unknown,
): Promise<void> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`handler ${name} not registered`);
  await handler(raw);
}

test('agent_end ends the open turn span and advances the turn counter', async () => {
  const { rt, handlers } = setup();
  registerTurn(rt);
  const turn = fakeTurnSpan();
  rt.state.turnSpan = turn.span;
  rt.state.turnCtx = ROOT_CONTEXT;
  rt.state.promptIndex = 2;
  await fire(handlers, 'agent_end', { messages: [] });
  assert.equal(turn.ended(), true, 'the turn span is ended');
  assert.equal(rt.state.turnSpan, null, 'turn span reference cleared');
  assert.equal(rt.state.turnCtx, null, 'turn context reference cleared');
  assert.equal(rt.state.promptIndex, 3, 'the turn counter advances');
});

test('agent_end with no open turn span is a no-op', async () => {
  const { rt, handlers } = setup();
  registerTurn(rt);
  rt.state.promptIndex = 0;
  await fire(handlers, 'agent_end', { messages: [] });
  assert.equal(rt.state.promptIndex, 0, 'no open turn span means the counter does not change');
});

test('before_agent_start buffers the prompt for the next turn', async () => {
  const { rt, handlers } = setup();
  registerTurn(rt);
  await fire(handlers, 'before_agent_start', { prompt: 'hello world' });
  assert.equal(rt.state.pendingPrompt, 'hello world');
});
