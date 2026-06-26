import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOT_CONTEXT, type Span, type Tracer } from '@opentelemetry/api';
import { createSpanState } from '../state.ts';
import { registerTool } from './tool.ts';
import type { Runtime } from '../runtime.ts';

interface SpanRecord {
  name: string;
  ended: boolean;
  attrs: Record<string, unknown>;
}

function setup(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, (raw: unknown) => unknown>();
  const spans: SpanRecord[] = [];
  const tracer = {
    startSpan(name: string) {
      const rec: SpanRecord = { name, ended: false, attrs: {} };
      const span = {
        setAttribute(key: string, value: unknown) {
          rec.attrs[key] = value;
          return span;
        },
        setStatus() {
          return span;
        },
        end() {
          rec.ended = true;
        },
      } as unknown as Span;
      spans.push(rec);
      return span;
    },
  } as unknown as Tracer;
  const rt = {
    pi: { on: (event: string, handler: (raw: unknown) => unknown) => handlers.set(event, handler) },
    state: createSpanState(),
    config: { captureToolIo: true, ...config },
    tracer,
    debug: () => {},
  } as unknown as Runtime;
  rt.state.sessionCtx = ROOT_CONTEXT;
  return { rt, handlers, spans };
}

async function fire(
  handlers: Map<string, (raw: unknown) => unknown>,
  name: string,
  raw: unknown,
): Promise<void> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`handler ${name} not registered`);
  await handler(raw);
}

test('parallel tools: out-of-order start/end keep separate spans keyed by call id', async () => {
  const { rt, handlers, spans } = setup();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'read',
    args: { path: 'x.ts' },
  });
  await fire(handlers, 'tool_execution_start', {
    toolCallId: 'b',
    toolName: 'bash',
    args: { command: 'ls' },
  });
  assert.equal(rt.state.toolSpans.size, 2, 'two concurrent tool spans are tracked');
  // End in the opposite order they started.
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'b',
    toolName: 'bash',
    result: 'ok',
    isError: false,
  });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'read',
    result: 'ok',
    isError: false,
  });
  assert.equal(rt.state.toolSpans.size, 0, 'both tool spans are closed');
  assert.equal(spans.length, 2);
  assert.ok(
    spans.every((s) => s.ended),
    'both spans ended exactly once',
  );
});

test('a duplicate tool_execution_start for the same call id is ignored', async () => {
  const { rt, handlers, spans } = setup();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  assert.equal(spans.length, 1, 'only one span for a repeated id');
  assert.equal(rt.state.toolSpans.size, 1);
});

test('tool_execution_end without a matching start is a no-op', async () => {
  const { rt, handlers, spans } = setup();
  registerTool(rt);
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'ghost',
    toolName: 'bash',
    result: 'x',
    isError: false,
  });
  assert.equal(spans.length, 0);
  assert.equal(rt.state.toolSpans.size, 0);
});

test('tool_execution_start is skipped while the session is disabled', async () => {
  const { rt, handlers, spans } = setup();
  registerTool(rt);
  rt.state.sessionDisabled = true;
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  assert.equal(spans.length, 0, 'no span opened while disabled');
  assert.equal(rt.state.toolSpans.size, 0);
});

test('a tool with no call id is ignored on both start and end', async () => {
  const { rt, handlers, spans } = setup();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', { toolName: 'bash', result: 'x', isError: false });
  assert.equal(spans.length, 0);
});

test('tool argument and result bodies are omitted when captureToolIo is off', async () => {
  const { rt, handlers, spans } = setup({ captureToolIo: false });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'cat .env' },
  });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: 'SECRET=1',
    isError: false,
  });
  const [span] = spans;
  assert.ok(span);
  assert.equal(span.attrs['gen_ai.tool.call.arguments'], undefined, 'args body suppressed');
  assert.equal(span.attrs['gen_ai.tool.call.result'], undefined, 'result body suppressed');
  assert.equal(span.attrs['gen_ai.tool.name'], 'bash', 'tool name still recorded');
  assert.equal(span.attrs['traceroot.pi.tool_is_error'], false, 'error state still recorded');
});
