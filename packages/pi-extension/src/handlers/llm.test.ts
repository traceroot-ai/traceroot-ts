import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import { registerLlm, resolveModel } from './llm.ts';
import type { Runtime } from '../runtime.ts';
import type { ExtensionContext } from '../types.ts';
import { fakeRuntime, fire, firstSpan, MODEL_CTX } from '../test-support.ts';

// ---------------------------------------------------------------------------
// resolveModel — live ctx.model preferred over the cached selection
// ---------------------------------------------------------------------------

test('resolveModel prefers live ctx.model over the cached selection', () => {
  const rt = {
    state: { currentModel: { provider: 'openai', id: 'gpt-4o' } },
  } as unknown as Runtime;
  const ctx = { model: { provider: 'anthropic', id: 'claude' } } as unknown as ExtensionContext;
  assert.deepEqual(resolveModel(rt, ctx), { provider: 'anthropic', id: 'claude' });
});

test('resolveModel falls back to the cached selection when ctx omits the model', () => {
  const rt = {
    state: { currentModel: { provider: 'openai', id: 'gpt-4o' } },
  } as unknown as Runtime;
  assert.deepEqual(resolveModel(rt, undefined), { provider: 'openai', id: 'gpt-4o' });
  assert.deepEqual(resolveModel(rt, {} as unknown as ExtensionContext), {
    provider: 'openai',
    id: 'gpt-4o',
  });
});

test('resolveModel returns null when neither source has a model', () => {
  const rt = { state: { currentModel: null } } as unknown as Runtime;
  assert.equal(resolveModel(rt, undefined), null);
});

// ---------------------------------------------------------------------------
// turn_start — span lifecycle, parent context, thinking level
// ---------------------------------------------------------------------------

test('turn_start ends a prior open LLM span at the same turnIndex instead of leaking it', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  assert.equal(rt.state.llmSpans.size, 1);
  assert.equal(spans[0]?.ended, false);
  // A second turn_start at the same index (re-emit, or two absent indices defaulting to
  // -1) must end the first span, not orphan it out of the map.
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  assert.equal(spans[0]?.ended, true, 'the first span is ended before being replaced');
  assert.equal(rt.state.llmSpans.size, 1, 'exactly one span remains tracked');
});

test('each turn gets its own LLM span with its own usage (no cross-turn bleed)', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'assistant', usage: { input: 10, output: 5 } },
  });
  await fire(handlers, 'turn_end', { turnIndex: 0 });
  await fire(handlers, 'turn_start', { turnIndex: 1 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'assistant', usage: { input: 20, output: 8 } },
  });
  const [first, second] = spans;
  assert.ok(first && second, 'one LLM span per turn/call');
  assert.equal(first.attrs['gen_ai.usage.output_tokens'], 5);
  assert.equal(second.attrs['gen_ai.usage.output_tokens'], 8);
});

test('turn_start does not open an orphan-root LLM span when no session context exists', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  rt.state.sessionCtx = null;
  rt.state.turnCtx = null;
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  assert.equal(spans.length, 0, 'no LLM span is opened without a parent context');
  assert.equal(rt.state.llmSpans.size, 0);
});

test('turn_start does not stamp a thinking_level when none was selected', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  assert.equal(firstSpan(spans).attrs['gen_ai.request.thinking_level'], undefined);
});

// ---------------------------------------------------------------------------
// message_end — token usage, error/aborted status
// ---------------------------------------------------------------------------

test('message_end records token usage on the active LLM span', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'assistant', usage: { input: 10, output: 5 } },
  });
  assert.equal(firstSpan(spans).attrs['gen_ai.usage.input_tokens'], 10);
  assert.equal(firstSpan(spans).attrs['gen_ai.usage.output_tokens'], 5);
});

test('message_end ignores non-assistant messages', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'user', usage: { input: 99, output: 99 } },
  });
  assert.equal(firstSpan(spans).attrs['gen_ai.usage.input_tokens'], undefined);
});

test('message_end with partial usage defaults the missing token field to 0', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', { message: { role: 'assistant', usage: { input: 12 } } });
  assert.equal(firstSpan(spans).attrs['gen_ai.usage.input_tokens'], 12);
  assert.equal(
    firstSpan(spans).attrs['gen_ai.usage.output_tokens'],
    0,
    'a missing output count defaults to 0',
  );
});

test('message_end with an error/aborted stopReason sets the span ERROR status (generic by default)', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: false });
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limit exceeded' },
  });
  assert.equal(firstSpan(spans).status?.code, SpanStatusCode.ERROR);
  assert.equal(
    firstSpan(spans).status?.message,
    'LLM turn error',
    'provider error string not exported by default',
  );
  assert.equal(firstSpan(spans).attrs['traceroot.pi.finish_reason'], 'error');
});

test('message_end error status includes the provider detail only under captureFullPayload', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: true });
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', {
    message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'user cancelled' },
  });
  assert.equal(firstSpan(spans).status?.code, SpanStatusCode.ERROR);
  assert.equal(firstSpan(spans).status?.message, 'user cancelled');
});

test('message_end with a normal stopReason does not set an error status', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'message_end', { message: { role: 'assistant', stopReason: 'stop' } });
  assert.equal(firstSpan(spans).status, undefined);
});

// ---------------------------------------------------------------------------
// before_provider_request — request-message privacy gate
// ---------------------------------------------------------------------------

const PAYLOAD = {
  messages: [
    { role: 'system', content: 'SECRET SYSTEM PROMPT' },
    { role: 'user', content: 'pii@example.com' },
  ],
};

test('before_provider_request records only the message count by default (no conversation export)', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: false });
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'before_provider_request', { payload: PAYLOAD });
  assert.equal(
    firstSpan(spans).attrs['traceroot.pi.request_message_count'],
    2,
    'count is safe to record',
  );
  assert.equal(
    firstSpan(spans).attrs['traceroot.span.input'],
    undefined,
    'conversation not exported without opt-in',
  );
  assert.equal(firstSpan(spans).attrs['traceroot.pi.full_request_payload'], undefined);
});

test('before_provider_request exports the conversation and full payload only under captureFullPayload', async () => {
  const { rt, handlers, spans } = fakeRuntime({ captureFullPayload: true });
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'before_provider_request', { payload: PAYLOAD });
  assert.ok(
    String(firstSpan(spans).attrs['traceroot.span.input'] ?? '').includes('SECRET SYSTEM PROMPT'),
  );
  assert.notEqual(firstSpan(spans).attrs['traceroot.pi.full_request_payload'], undefined);
});

// ---------------------------------------------------------------------------
// after_provider_response — HTTP status, rate-limit headers, error events
// ---------------------------------------------------------------------------

test('after_provider_response records status, rate-limit headers, and a rate_limited event on 429', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'after_provider_response', {
    status: 429,
    headers: {
      'x-ratelimit-remaining': '0',
      'Retry-After': '30',
      'content-type': 'application/json',
    },
  });
  const span = firstSpan(spans);
  assert.equal(span.attrs['http.status_code'], 429);
  assert.equal(span.attrs['traceroot.pi.x_ratelimit_remaining'], '0');
  assert.equal(
    span.attrs['traceroot.pi.retry_after'],
    '30',
    'Retry-After captured case-insensitively, key normalized',
  );
  assert.equal(
    span.attrs['traceroot.pi.content_type'],
    undefined,
    'non-ratelimit headers not captured',
  );
  const rateLimited = span.events.find((e) => e.name === 'rate_limited');
  assert.ok(rateLimited, 'a rate_limited event is added on 429');
  assert.equal(
    rateLimited.attrs['http.retry_after'],
    '30',
    'the event carries the retry-after value',
  );
});

test('after_provider_response adds a provider_error event on a 5xx status', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'after_provider_response', { status: 503, headers: {} });
  const span = firstSpan(spans);
  assert.equal(span.attrs['http.status_code'], 503);
  assert.ok(span.events.some((e) => e.name === 'provider_error'));
});

test('after_provider_response ignores a non-numeric status', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 0 }, MODEL_CTX);
  await fire(handlers, 'after_provider_response', { status: 'oops', headers: {} });
  assert.equal(firstSpan(spans).attrs['http.status_code'], undefined);
});

// A handler that fires with no open LLM span (currentLlm() undefined) must no-op.
test('provider response/request handlers no-op when no LLM span is open', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  registerLlm(rt);
  await fire(handlers, 'before_provider_request', { payload: PAYLOAD });
  await fire(handlers, 'after_provider_response', { status: 200, headers: {} });
  assert.equal(spans.length, 0, 'nothing recorded without an active LLM span');
});

// turn_start uses the registered ROOT_CONTEXT (set by fakeRuntime) as a stand-in for the
// session context that agent_start establishes in real flow.
test('turn_start opens the LLM span under the session context', async () => {
  const { rt, handlers, spans } = fakeRuntime();
  rt.state.sessionCtx = ROOT_CONTEXT;
  registerLlm(rt);
  await fire(handlers, 'turn_start', { turnIndex: 3 }, MODEL_CTX);
  assert.equal(spans.length, 1);
  assert.equal(firstSpan(spans).attrs['traceroot.pi.turn_index'], 3);
  assert.equal(firstSpan(spans).attrs['gen_ai.request.model'], 'gpt-4o');
});
