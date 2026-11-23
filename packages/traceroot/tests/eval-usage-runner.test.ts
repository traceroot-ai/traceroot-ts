// End to end: a LOCAL runner run of an eval module that instruments the real `openai` client,
// pointed at an in-process OpenAI-compatible server on 127.0.0.1. The run file and the case lines
// must carry exactly the usage the server returned, and nothing may reach a traceroot endpoint.

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

// What the fake server reports per request, keyed by the last user message.
const USAGE: Record<string, Record<string, unknown>> = {
  'task:a:1': {
    prompt_tokens: 11,
    completion_tokens: 3,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 4 },
  },
  'task:a:2': {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    completion_tokens_details: { reasoning_tokens: 2 },
  },
  'judge:a': { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 },
  'task:b:1': { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  'task:b:2': { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
  'judge:b': { prompt_tokens: 300, completion_tokens: 2, total_tokens: 302 },
};

let server: Server;
let baseUrl: string;
const requests: string[] = [];

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
      const usage = USAGE[key];
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send(chunk({ role: 'assistant', content: 'stre' }, null));
        send(chunk({ content: 'amed' }, null));
        send(chunk({}, 'stop'));
        // Like OpenAI, a usage chunk only when the request asks for one (stream_options).
        if (parsed.stream_options?.include_usage && usage) {
          send({ ...chunk({}, null), choices: [], usage });
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
          usage,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

const EVAL_SRC = (port: string) => `
import * as openai from '${openaiEntry}';
import { TraceRoot } from '${srcDir}/traceroot';
import { Dataset, Evaluation } from '${srcDir}/eval';

TraceRoot.initialize({ instrumentModules: { openAI: openai } });
const client = new openai.OpenAI({ apiKey: 'sk-fake', baseURL: '${port}/v1', maxRetries: 0 });
const ask = (content: string) =>
  client.chat.completions.create({ model: 'fake-model', messages: [{ role: 'user', content }] });

const ds = new Dataset('usage-e2e');
ds.add({ q: 'a' }, { id: 'a' });
ds.add({ q: 'b' }, { id: 'b' });

async function task(x: any) {
  await ask('task:' + x.q + ':1');
  await ask('task:' + x.q + ':2');
  // No stream_options.include_usage: the provider sends no usage chunk for this stream.
  const stream = await client.chat.completions.create({
    model: 'fake-model',
    stream: true,
    messages: [{ role: 'user', content: 'task:' + x.q + ':stream' }],
  });
  let text = '';
  for await (const part of stream) text += part.choices[0]?.delta?.content ?? '';
  return text;
}

async function judged(ctx: any) {
  await ask('judge:' + ctx.input.q);
  return 1;
}

export const e = new Evaluation({
  name: 'usage-e2e',
  dataset: ds,
  task,
  scorers: [judged],
  maxConcurrency: 2,
});
`;

describe('local runner records LLM usage end to end', () => {
  it('writes the exact usage the provider returned, and sends nothing to traceroot', async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((input: unknown, ...rest: unknown[]) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realFetch as any)(input, ...rest);
    }) as typeof fetch;
    // Ambient credentials pointing at the fake server: any export or upload would land there.
    process.env['TRACEROOT_API_KEY'] = 'tr-ambient';
    process.env['TRACEROOT_HOST_URL'] = baseUrl;

    const dir = mkdtempSync(join(tmpdir(), 'usage-e2e-'));
    const evalFile = join(dir, 'usage_eval.ts');
    writeFileSync(evalFile, EVAL_SRC(baseUrl));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: Record<string, any>[] = [];
    try {
      await runSuite(
        [evalFile],
        { reporting: false, out_dir: join(dir, 'runs') },
        new Emitter((ln) => events.push(JSON.parse(ln))),
      );
    } finally {
      globalThis.fetch = realFetch;
      delete process.env['TRACEROOT_API_KEY'];
      delete process.env['TRACEROOT_HOST_URL'];
      delete process.env['TRACEROOT_ENABLED'];
    }

    assert.ok(!events.some((e) => e.type === 'fatal'), JSON.stringify(events));
    const none = {
      cache_write_tokens: null,
      cost: null,
      llm_calls_with_cost: 0,
      currency: null,
    };
    // A stream whose provider sends no usage chunk counts as a call without usage, so each task
    // bucket has one call more than it has calls with usage.
    const expected: Record<string, unknown> = {
      a: {
        task: {
          llm_calls: 3,
          llm_calls_with_usage: 2,
          input_tokens: 31,
          output_tokens: 8,
          total_tokens: 39,
          cache_read_tokens: 4,
          cache_write_tokens: null,
          reasoning_tokens: 2,
          cost: null,
          llm_calls_with_cost: 0,
          currency: null,
        },
        scorers: {
          llm_calls: 1,
          llm_calls_with_usage: 1,
          input_tokens: 30,
          output_tokens: 1,
          total_tokens: 31,
          cache_read_tokens: null,
          reasoning_tokens: null,
          ...none,
        },
      },
      b: {
        task: {
          llm_calls: 3,
          llm_calls_with_usage: 2,
          input_tokens: 300,
          output_tokens: 30,
          total_tokens: 330,
          cache_read_tokens: null,
          reasoning_tokens: null,
          ...none,
        },
        scorers: {
          llm_calls: 1,
          llm_calls_with_usage: 1,
          input_tokens: 300,
          output_tokens: 2,
          total_tokens: 302,
          cache_read_tokens: null,
          reasoning_tokens: null,
          ...none,
        },
      },
    };
    const runTotal = {
      task: {
        llm_calls: 6,
        llm_calls_with_usage: 4,
        input_tokens: 331,
        output_tokens: 38,
        total_tokens: 369,
        cache_read_tokens: 4,
        reasoning_tokens: 2,
        ...none,
      },
      scorers: {
        llm_calls: 2,
        llm_calls_with_usage: 2,
        input_tokens: 330,
        output_tokens: 3,
        total_tokens: 333,
        cache_read_tokens: null,
        reasoning_tokens: null,
        ...none,
      },
    };

    // case_completed events
    const completedCases = events.filter((e) => e.type === 'case_completed');
    assert.equal(completedCases.length, 2);
    for (const c of completedCases) assert.deepEqual(c.usage, expected[c.case_id]);

    // evaluation_completed + the run document
    const done = events.find((e) => e.type === 'evaluation_completed');
    assert.deepEqual(done.usage, runTotal);
    const runDoc = JSON.parse(readFileSync(done.artifact.run, 'utf8'));
    assert.deepEqual(runDoc.usage, runTotal);
    for (const c of runDoc.cases) assert.deepEqual(c.usage, expected[c.case_id]);

    // the cases.jsonl lines
    const lines = readFileSync(done.artifact.cases, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    for (const line of lines) assert.deepEqual(line.usage, expected[line.case_id]);

    // Only the model calls left the process, all to the fake provider.
    assert.equal(requests.length, 8);
    assert.ok(
      requests.every((r) => r === 'POST /v1/chat/completions'),
      requests.join(', '),
    );
    assert.ok(fetched.length > 0);
    assert.ok(
      fetched.every((u) => u === `${baseUrl}/v1/chat/completions`),
      fetched.join(', '),
    );
  });
});
