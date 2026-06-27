import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpanStatusCode } from '@opentelemetry/api';
import { registerTool } from './tool.ts';
import { fakeRuntime, fire, firstSpan } from '../test-support.ts';

// ---------------------------------------------------------------------------
// Span bookkeeping: parallel safety, double-open / end-without-start guards
// ---------------------------------------------------------------------------

test('parallel tools: out-of-order start/end keep separate spans keyed by call id', async () => {
  const { rt, handlers, spans } = fakeRuntime();
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
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  assert.equal(spans.length, 1, 'only one span for a repeated id');
  assert.equal(rt.state.toolSpans.size, 1);
});

test('tool_execution_end without a matching start is a no-op', async () => {
  const { rt, handlers, spans } = fakeRuntime();
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
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  rt.state.sessionDisabled = true;
  await fire(handlers, 'tool_execution_start', { toolCallId: 'a', toolName: 'bash', args: {} });
  assert.equal(spans.length, 0, 'no span opened while disabled');
  assert.equal(rt.state.toolSpans.size, 0);
});

test('a tool with no call id is ignored on both start and end', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', { toolName: 'bash', result: 'x', isError: false });
  assert.equal(spans.length, 0);
});

// ---------------------------------------------------------------------------
// Content capture (captureToolIo) and recorded attributes
// ---------------------------------------------------------------------------

test('tool name, id, error state, and duration are always recorded', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'ls' },
  });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: 'ok',
    isError: false,
  });
  const span = firstSpan(spans);
  assert.equal(span.attrs['gen_ai.tool.name'], 'bash');
  assert.equal(span.attrs['gen_ai.tool.call.id'], 'a');
  assert.equal(span.attrs['traceroot.pi.tool_is_error'], false);
  assert.equal(typeof span.attrs['traceroot.pi.tool_duration_ms'], 'number');
});

test('tool argument and result bodies are captured by default and omitted when captureToolIo is off', async () => {
  const on = fakeRuntime({ captureToolIo: true });
  registerTool(on.rt);
  await fire(on.handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'echo hi' },
  });
  await fire(on.handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: 'hi',
    isError: false,
  });
  assert.ok(firstSpan(on.spans).attrs['gen_ai.tool.call.arguments'], 'args captured by default');
  assert.ok(firstSpan(on.spans).attrs['gen_ai.tool.call.result'], 'result captured by default');

  const off = fakeRuntime({ captureToolIo: false });
  registerTool(off.rt);
  await fire(off.handlers, 'tool_execution_start', {
    toolCallId: 'a',
    toolName: 'bash',
    args: { command: 'cat .env' },
  });
  await fire(off.handlers, 'tool_execution_end', {
    toolCallId: 'a',
    toolName: 'bash',
    result: 'SECRET=1',
    isError: false,
  });
  const span = firstSpan(off.spans);
  assert.equal(span.attrs['gen_ai.tool.call.arguments'], undefined, 'args body suppressed');
  assert.equal(span.attrs['gen_ai.tool.call.result'], undefined, 'result body suppressed');
  assert.equal(span.attrs['gen_ai.tool.name'], 'bash', 'tool name still recorded');
});

// ---------------------------------------------------------------------------
// Error reporting: OTel span ERROR status without leaking content
// ---------------------------------------------------------------------------

test('an errored tool flags tool_is_error, ends the span, and sets an ERROR status with an extracted message', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureToolIo: true });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'c1',
    toolName: 'bash',
    result: 'command not found',
    isError: true,
  });
  const span = firstSpan(spans);
  assert.equal(span.attrs['traceroot.pi.tool_is_error'], true);
  assert.equal(span.ended, true);
  assert.equal(span.status?.code, SpanStatusCode.ERROR);
  assert.equal(span.status?.message, 'command not found');
});

test('tool error status message stays generic (no content leak) when tool-IO capture is off', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureToolIo: false });
  registerTool(rt);
  await fire(handlers, 'tool_execution_start', { toolCallId: 'c1', toolName: 'bash', args: {} });
  await fire(handlers, 'tool_execution_end', {
    toolCallId: 'c1',
    toolName: 'bash',
    result: 'secret output that must not leak',
    isError: true,
  });
  const span = firstSpan(spans);
  assert.equal(span.status?.code, SpanStatusCode.ERROR);
  assert.equal(
    span.status?.message,
    'bash failed',
    'result content must not leak into the status message',
  );
});
