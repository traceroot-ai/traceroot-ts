/* global require, process, console, Response, Headers */
/* eslint-disable @typescript-eslint/no-require-imports */
// Fresh-process fixture: every response and exported span stays in memory.
const assert = require('node:assert/strict');
const net = require('node:net');
const { trace } = require('@opentelemetry/api');
const { AlwaysOffSampler } = require('@opentelemetry/sdk-trace-base');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
net.Socket.prototype.connect = function () {
  throw new Error('Unexpected network access');
};
const captured = [];
OTLPTraceExporter.prototype.export = function (spans, done) {
  captured.push(...spans);
  done({ code: 0 });
};
const [
  mode = 'both',
  style = 'create',
  beta = '0',
  format = 'cjs',
  version = 'modern',
  privacy = '0',
] = process.argv.slice(2);
const fallback = mode === 'fallback' || mode === 'throwing';
if (fallback) {
  const off = new NodeTracerProvider({ sampler: new AlwaysOffSampler() });
  const getTracer = NodeTracerProvider.prototype.getTracer;
  NodeTracerProvider.prototype.getTracer = function (name, ...args) {
    return name === '@arizeai/openinference-instrumentation-anthropic'
      ? getTracer.call(off, name, ...args)
      : getTracer.call(this, name, ...args);
  };
}
(async () => {
  const pkg =
    version === 'minimum'
      ? 'anthropic-minimum'
      : version === 'legacy'
        ? 'anthropic-legacy'
        : version === 'native-first'
          ? 'anthropic-native'
          : '@anthropic-ai/sdk';
  const { TraceRoot } = require('../../src/traceroot.ts');
  if (format === 'auto')
    TraceRoot.initialize({
      apiKey: 'offline-placeholder',
      baseUrl: 'http://offline.invalid',
      gitRepo: 'offline/mock',
      gitRef: 'offline',
      disableBatch: true,
    });
  const module = format === 'esm' ? await import(pkg) : require(pkg);
  const Anthropic = module.default ?? module;
  const { usingAttributes } = require('../../src/usingAttributes.ts');
  let requests = 0;
  const propagated = [];
  const usage = {
    input_tokens: 598,
    output_tokens: 53,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
  };
  const message = {
    id: 'msg_offline',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'private-response' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  };
  const events = [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...usage, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'private-response' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 53 },
    },
    { type: 'message_stop' },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const client = new Anthropic({
    apiKey: 'offline-placeholder',
    maxRetries: 0,
    ...(mode === 'oi-only'
      ? { openTelemetry: false }
      : {
          openTelemetry: {
            traces: { contentMode: 'content' },
            ...(mode === 'throwing'
              ? {
                  tracerProvider: {
                    getTracer: () => ({
                      startSpan() {
                        throw new Error('broken native telemetry');
                      },
                    }),
                  },
                }
              : {}),
          },
        }),
    fetch: async (_url, init) => {
      requests++;
      propagated.push(new Headers(init.headers).get('traceparent'));
      const request = JSON.parse(init.body);
      if (mode === 'nested' && request.messages[0].content === 'private-request') {
        await nativeCreate({
          model: 'claude-sonnet-4-6',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'native-request' }],
        });
      }
      if (style === 'count')
        return new Response(JSON.stringify({ input_tokens: 598 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const http = trace.getTracer('offline.http').startSpan('HTTP POST');
      http.end();
      if (style === 'error-stream')
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'mock rejected request' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      const stream = JSON.parse(init.body).stream;
      return new Response(stream ? body : JSON.stringify(message), {
        status: 200,
        headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
      });
    },
  });
  const resource = beta === '1' ? client.beta.messages : client.messages;
  const nativeCreate = resource.create.bind(resource);
  const nativeTracerBefore = client._tracer;
  if (format !== 'auto')
    TraceRoot.initialize({
      apiKey: 'offline-placeholder',
      baseUrl: 'http://offline.invalid',
      gitRepo: 'offline/mock',
      gitRef: 'offline',
      disableBatch: true,
      instrumentModules: mode === 'native-only' ? {} : { anthropic: module },
    });
  const run = async () => {
    const args = {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'private-request' }],
    };
    if (style === 'count') assert.equal((await resource.countTokens(args)).input_tokens, 598);
    else if (style === 'error-stream')
      await assert.rejects(resource.stream(args).finalMessage(), /mock rejected request/);
    else if (style === 'create')
      assert.equal((await resource.create(args)).content[0].text, 'private-response');
    else if (style === 'stream')
      assert.equal(
        (await resource.stream(args).finalMessage()).content[0].text,
        'private-response',
      );
    else {
      const stream = await resource.create({ ...args, stream: true });
      const received = [];
      for await (const event of stream) received.push(event.type);
      assert.equal(received.at(-1), 'message_stop');
    }
  };
  await usingAttributes({ userId: 'offline-user', sessionId: 'offline-session' }, () =>
    Promise.all([run(), run()]),
  );
  await TraceRoot.flush();
  assert.equal(client._tracer, nativeTracerBefore, 'client tracing state must not be mutated');
  if (style === 'count') {
    const counts = captured.filter((s) => s.name === 'Anthropic Count Tokens');
    assert.equal(requests, 2);
    assert.equal(counts.length, 2);
    assert.ok(
      !captured.some((s) => s.instrumentationLibrary.name === 'com.anthropic.sdk.typescript'),
    );
    for (const span of counts) assert.ok(String(span.attributes['output.value']).includes('598'));
    console.log(JSON.stringify({ requests, spans: counts.length }));
    await TraceRoot.shutdown();
    return;
  }
  const spans = captured.filter(
    (s) =>
      s.attributes['llm.token_count.prompt'] !== undefined ||
      s.attributes['gen_ai.usage.input_tokens'] !== undefined,
  );
  const input = spans.reduce(
    (n, s) =>
      n +
      (s.attributes['llm.token_count.prompt'] ??
        s.attributes['gen_ai.usage.input_tokens'] +
          (s.attributes['gen_ai.usage.cache_read.input_tokens'] ??
            s.attributes['gen_ai.usage.cache_read_input_tokens'] ??
            0) +
          (s.attributes['gen_ai.usage.cache_creation.input_tokens'] ??
            s.attributes['gen_ai.usage.cache_creation_input_tokens'] ??
            0)),
    0,
  );
  const output = spans.reduce(
    (n, s) =>
      n +
      (s.attributes['llm.token_count.completion'] ?? s.attributes['gen_ai.usage.output_tokens']),
    0,
  );
  assert.equal(requests, mode === 'nested' ? 4 : 2);
  const expected = style === 'error-stream' || mode === 'throwing' ? 0 : mode === 'nested' ? 4 : 2;
  assert.equal(
    spans.length,
    expected,
    JSON.stringify(captured.map((s) => ({ name: s.name, attrs: s.attributes }))),
  );
  assert.equal(input, expected ? (mode === 'nested' ? 2512 : 1256) : 0);
  assert.equal(output, expected ? (mode === 'nested' ? 212 : 106) : 0);
  if (style === 'error-stream') assert.equal(captured.filter((s) => s.status.code === 2).length, 2);
  if (nativeTracerBefore && mode !== 'oi-only' && expected)
    for (const header of propagated) {
      assert.ok(
        header && spans.some((s) => header.includes(s.spanContext().spanId)),
        'trace headers must carry the usage owner context',
      );
    }
  for (const http of captured.filter((s) => s.name === 'HTTP POST' && expected)) {
    assert.ok(
      spans.some((s) => s.spanContext().spanId === http.parentSpanId),
      'HTTP span must remain a child of its usage owner',
    );
  }
  if (mode === 'both' || mode === 'oi-only')
    for (const span of spans) {
      assert.equal(span.attributes['user.id'], 'offline-user');
      assert.equal(span.attributes['session.id'], 'offline-session');
      const attrs = JSON.stringify(span.attributes);
      if (privacy === '1') {
        assert.ok(!attrs.includes('private-request'), attrs);
        assert.ok(!attrs.includes('private-response'), attrs);
      } else {
        assert.ok(attrs.includes('private-request'), attrs);
        assert.ok(attrs.includes('private-response'), attrs);
      }
    }
  console.log(
    JSON.stringify({
      requests,
      spans: spans.length,
      input,
      output,
      scopes: spans.map((s) => s.instrumentationLibrary.name),
    }),
  );
  await TraceRoot.shutdown();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
