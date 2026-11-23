// Integration: a LOCAL runner run of an eval module that instruments the real `openai` client
// against an in-process OpenAI-compatible server. Covers streamed usage, a retried call, an
// aborted stream, a wrapper LLM span (context propagation), concurrent cases
// and task vs scorer attribution, with nothing sent to traceroot.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Emitter, runSuite } from '../src/eval';

const srcDir = join(__dirname, '..', 'src').replace(/\\/g, '/');
const openaiEntry = require.resolve('openai').replace(/\\/g, '/');

// Usage per call, keyed by "<kind>:<case>". Case b's numbers are case a's times 10.
const BASE: Record<string, { prompt_tokens: number; completion_tokens: number }> = {
  plain: { prompt_tokens: 1, completion_tokens: 1 },
  stream: { prompt_tokens: 2, completion_tokens: 2 },
  retry: { prompt_tokens: 4, completion_tokens: 4 },
  nested: { prompt_tokens: 8, completion_tokens: 8 },
  judge: { prompt_tokens: 16, completion_tokens: 1 },
};
function usageFor(key: string) {
  const [kind, id] = key.split(':');
  const base = BASE[kind];
  if (!base) return undefined;
  const k = id === 'b' ? 10 : 1;
  const p = base.prompt_tokens * k;
  const c = base.completion_tokens * k;
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

let server: Server;
let baseUrl: string;
const requests: string[] = [];
const retried = new Set<string>();

function chunk(delta: Record<string, unknown>, finish: string | null): Record<string, unknown> {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body);
      const key = parsed.messages[parsed.messages.length - 1].content as string;
      const [kind] = key.split(':');
      // The first attempt of a retried call fails; the client retries inside the same call.
      if (kind === 'retry' && !retried.has(key)) {
        retried.add(key);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'try again' } }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send(chunk({ role: 'assistant', content: 'par' }, null));
        if (kind === 'cut') {
          // The server drops the connection mid-stream.
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        if (kind === 'abort') return; // keeps the stream open; the client aborts it
        send(chunk({ content: 'tial' }, 'stop'));
        if (parsed.stream_options?.include_usage) {
          send({ ...chunk({}, null), choices: [], usage: usageFor(key) });
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: 0,
          model: 'fake-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: usageFor(key),
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const EVAL_SRC = (url: string) => `
import * as openai from '${openaiEntry}';
import { TraceRoot } from '${srcDir}/traceroot';
import { observe } from '${srcDir}/observe';
import { Dataset, Evaluation } from '${srcDir}/eval';

TraceRoot.initialize({ instrumentModules: { openAI: openai } });
const client = new openai.OpenAI({ apiKey: 'sk-fake', baseURL: '${url}/v1', maxRetries: 2 });
const ask = (content: string) =>
  client.chat.completions.create({ model: 'fake-model', messages: [{ role: 'user', content }] });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ds = new Dataset('usage-integration');
ds.add({ q: 'a' }, { id: 'a' });
ds.add({ q: 'b' }, { id: 'b' });

async function task(x: any) {
  await pause(x.q === 'a' ? 5 : 1);
  await ask('plain:' + x.q);
  const stream = await client.chat.completions.create({
    model: 'fake-model',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'stream:' + x.q }],
  });
  for await (const part of stream) void part;
  await ask('retry:' + x.q);
  // A wrapper LLM span around the provider call: counted once only if the call's span is its child.
  await observe({ name: 'wrapper', type: 'llm' }, () => ask('nested:' + x.q));
  const aborted = await client.chat.completions.create({
    model: 'fake-model',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'abort:' + x.q }],
  });
  for await (const part of aborted) {
    void part;
    aborted.controller.abort();
  }
  return 'done';
}

async function judged(ctx: any) {
  await ask('judge:' + ctx.input.q);
  return 1;
}

export const e = new Evaluation({ name: 'usage-integration', dataset: ds, task, scorers: [judged] });
`;

/** A bucket of `calls` calls, `reported` of which reported input and output (so a total). */
function bucket(calls: number, reported: number, input: number, output: number) {
  return {
    llm_calls: calls,
    input_tokens: input,
    llm_calls_with_input_tokens: reported,
    output_tokens: output,
    llm_calls_with_output_tokens: reported,
    total_tokens: input + output,
    llm_calls_with_total_tokens: reported,
    cache_read_tokens: null,
    llm_calls_with_cache_read_tokens: 0,
    cache_write_tokens: null,
    llm_calls_with_cache_write_tokens: 0,
    reasoning_tokens: null,
    llm_calls_with_reasoning_tokens: 0,
    cost: null,
    llm_calls_with_cost: 0,
    currency: null,
  };
}

describe('local runner, real openai client', () => {
  it('records each kind of call exactly once, per case and per role', async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: unknown, ...rest: unknown[]) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realFetch as any)(input, ...rest);
    }) as typeof fetch;
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => void rejections.push(r);
    process.on('unhandledRejection', onRejection);
    process.env['TRACEROOT_API_KEY'] = 'tr-ambient';
    process.env['TRACEROOT_HOST_URL'] = baseUrl;

    const dir = mkdtempSync(join(tmpdir(), 'usage-integration-'));
    const evalFile = join(dir, 'usage_eval.ts');
    writeFileSync(evalFile, EVAL_SRC(baseUrl));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: Record<string, any>[] = [];
    const started = Date.now();
    try {
      await runSuite(
        [evalFile],
        { reporting: false, out_dir: join(dir, 'runs'), max_concurrency: 2, timeout: 20 },
        new Emitter((ln) => events.push(JSON.parse(ln))),
      );
    } finally {
      globalThis.fetch = realFetch;
      delete process.env['TRACEROOT_API_KEY'];
      delete process.env['TRACEROOT_HOST_URL'];
      delete process.env['TRACEROOT_ENABLED'];
    }
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onRejection);

    assert.ok(!events.some((e) => e.type === 'fatal'), JSON.stringify(events));
    const done = events.find((e) => e.type === 'evaluation_completed');
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.ok(Date.now() - started < 10_000, 'no case hung');

    // plain + stream + retry + nested (wrapper not counted) carry usage; the aborted stream does not.
    const expected = (k: number) => ({
      task: bucket(5, 4, 15 * k, 15 * k),
      scorers: bucket(1, 1, 16 * k, 1 * k),
    });
    const cases = Object.fromEntries(
      events.filter((e) => e.type === 'case_completed').map((e) => [e.case_id, e.usage]),
    );
    assert.deepEqual(cases, { a: expected(1), b: expected(10) });
    const lines = readFileSync(done.artifact.cases, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    for (const line of lines) assert.deepEqual(line.usage, cases[line.case_id]);
    assert.deepEqual(done.usage, {
      task: bucket(10, 8, 165, 165),
      scorers: bucket(2, 2, 176, 11),
    });

    // Every request went to the fake provider; each retried call hit it twice.
    assert.ok(
      requests.every((r) => r === 'POST /v1/chat/completions'),
      requests.join(', '),
    );
    assert.equal(requests.length, 2 * 7);
    assert.ok(
      fetched.every((u) => u === `${baseUrl}/v1/chat/completions`),
      fetched.join(', '),
    );
    assert.deepEqual(rejections, [], 'no unhandled rejection');
  });
});
