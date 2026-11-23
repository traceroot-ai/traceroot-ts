// The OpenAI instrumentation on the SDK's own tracer provider, against an in-process
// OpenAI-compatible server: each chat completion reaches the exporter as exactly one LLM span, a
// streamed completion carries the token counts its final usage chunk reports, and a stream that is
// dropped or aborted midway still ends its span without bringing the process down.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { ExportResultCode, suppressTracing, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import * as openai from 'openai';

import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { TraceRootSpanProcessor } from '../src/processor';

const USAGE = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };

let server: Server;
let client: openai.OpenAI;
const exported: ReadableSpan[] = [];

function chunk(delta: Record<string, unknown>, finish: string | null): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (!parsed.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 0,
            model: 'test-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: USAGE,
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send(chunk({ role: 'assistant', content: 'o' }, null));
      const prompt = parsed.messages[parsed.messages.length - 1].content;
      if (prompt === 'drop') {
        // The server drops the connection mid-stream.
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if (prompt === 'hold') return; // stays open until the client aborts it
      send(chunk({ content: 'k' }, 'stop'));
      // As OpenAI does: a final chunk with empty choices, only when the request asks for usage.
      if (parsed.stream_options?.include_usage)
        send({ ...chunk({}, null), choices: [], usage: USAGE });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  _resetForTesting();
  TraceRoot.initialize({
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:9',
    disableBatch: true,
    instrumentModules: { openAI: openai },
  });
  // Swap the OTLP exporter's send for a recorder: spans travel the whole processor chain and
  // arrive at the exporter exactly as they would be sent, but nothing leaves the process.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gp = trace.getTracerProvider() as any;
  const delegate = typeof gp.getDelegate === 'function' ? gp.getDelegate() : gp;
  const proc = (delegate._registeredSpanProcessors as unknown[]).find(
    (p) => p instanceof TraceRootSpanProcessor,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exporter = (proc as any).inner._exporter;
  exporter.export = (spans: ReadableSpan[], done: (r: ExportResult) => void) => {
    exported.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  };

  client = new openai.OpenAI({
    apiKey: 'sk-test',
    baseURL: `http://127.0.0.1:${port}/v1`,
    maxRetries: 0,
  });
});

after(async () => {
  await TraceRoot.shutdown();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  exported.length = 0;
});

/** The exported LLM spans, once `count` have ended (a stream's span ends when the instrumentation
 *  has read its own copy of the stream, which can trail the caller's read). */
async function llmSpans(count: number): Promise<ReadableSpan[]> {
  const llm = () => exported.filter((s) => s.attributes['openinference.span.kind'] === 'LLM');
  for (let i = 0; i < 50 && llm().length < count; i++) await new Promise((r) => setTimeout(r, 10));
  return llm();
}

function tokenCounts(span: ReadableSpan): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(span.attributes).filter(([k]) => k.startsWith('llm.token_count.')),
  );
}

const say = (content: string) => ({
  model: 'test-model',
  messages: [{ role: 'user' as const, content }],
});
const ask = say('hi');

describe('OpenAI chat completions through the SDK provider', () => {
  it('exports one LLM span with the token counts of a completion', async () => {
    await client.chat.completions.create(ask);
    const spans = await llmSpans(1);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attributes['traceroot.sdk.name'], 'traceroot-ts');
    assert.deepEqual(tokenCounts(spans[0]), {
      'llm.token_count.prompt': 11,
      'llm.token_count.completion': 3,
      'llm.token_count.total': 14,
    });
  });

  it('exports the usage of a streamed completion that asked for it', async () => {
    const stream = await client.chat.completions.create({
      ...ask,
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    for await (const part of stream) text += part.choices[0]?.delta?.content ?? '';
    assert.equal(text, 'ok');
    const spans = await llmSpans(1);
    assert.equal(spans.length, 1, 'one span per streamed completion');
    assert.deepEqual(tokenCounts(spans[0]), {
      'llm.token_count.prompt': 11,
      'llm.token_count.completion': 3,
      'llm.token_count.total': 14,
    });
  });

  it("exports nothing for a call made under the SDK's suppressed context", async () => {
    // The instrumentation carries its own @opentelemetry/core; suppression must still hold.
    await context.with(suppressTracing(context.active()), () =>
      client.chat.completions.create(ask),
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(exported, []);
  });

  it('exports a stream without a usage chunk as a span with no token counts', async () => {
    const stream = await client.chat.completions.create({ ...ask, stream: true });
    for await (const part of stream) void part;
    const spans = await llmSpans(1);
    assert.equal(spans.length, 1);
    assert.deepEqual(tokenCounts(spans[0]), {});
  });

  // Before 4.4.5 the instrumentation's own read of a failed stream rejected unhandled: the span
  // never ended and the process exited, even when the caller had caught the error.
  it('ends the span of a stream the server drops midway, as an error', async () => {
    const stream = await client.chat.completions.create({ ...say('drop'), stream: true });
    await assert.rejects(async () => {
      for await (const part of stream) void part;
    });
    const spans = await llmSpans(1);
    assert.equal(spans.length, 1, 'the span ended');
    assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
    assert.deepEqual(tokenCounts(spans[0]), {});
  });

  it('ends the span of a stream the caller aborts, without an error', async () => {
    const stream = await client.chat.completions.create({ ...say('hold'), stream: true });
    for await (const part of stream) {
      void part;
      stream.controller.abort();
    }
    const spans = await llmSpans(1);
    assert.equal(spans.length, 1, 'the span ended');
    assert.notEqual(spans[0].status.code, SpanStatusCode.ERROR);
    assert.deepEqual(tokenCounts(spans[0]), {});
  });
});
