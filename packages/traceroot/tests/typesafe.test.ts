import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import * as typeSafe from '@typesafe-ai/sdk';
import { wireInstrumentations } from '../src/instrumentation';
import { observe } from '../src/observe';
import { _resetForTesting } from '../src/traceroot';
import { usingAttributes } from '../src/usingAttributes';

const SPAN_NAME = 'TypeSafeClient.systemOne';

const request = {
  state: 'I was charged twice for my subscription this month. Please refund one charge.',
  questions: {
    category: typeSafe.choice('What is this ticket about?', { billing: null, technical: null }),
    urgent: typeSafe.noul('Does the customer need a reply today?'),
  },
};

const result = {
  model: 'jev-1.13.0',
  answers: {
    category: {
      type: 'choice',
      choice: 'billing',
      confidence: 0.94,
      probabilities: { billing: 0.97, technical: 0.03 },
    },
    urgent: { type: 'noul', noul: 0.71 },
  },
  usage: { input_tokens: 42, output_tokens: 7 },
};

// Each queued response answers one fetch; the last one repeats.
function makeClient(...responses: (() => Response)[]) {
  const calls: RequestInit[] = [];
  const queue = responses.length > 0 ? responses : [() => Response.json(result)];
  const client = new typeSafe.TypeSafeClient({
    apiKey: 'test-key',
    logLevel: 'off',
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      calls.push(init ?? {});
      return queue[Math.min(calls.length, queue.length) - 1]();
    },
  });
  return { client, calls };
}

describe('TypeSafe instrumentation', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  // One provider for the whole suite: the instrumentor binds to the global provider when it
  // is wired and owns the patched prototype for the life of the process, so it can't be
  // re-wired against a fresh provider per test.
  before(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
    wireInstrumentations({ typeSafe });
  });

  afterEach(() => {
    exporter.reset();
  });

  after(async () => {
    await provider.shutdown();
    _resetForTesting();
  });

  function typeSafeSpans() {
    return exporter.getFinishedSpans().filter((s) => s.name === SPAN_NAME);
  }

  it('records one LLM span per systemOne call, nested under observe and carrying usingAttributes', async () => {
    const { client } = makeClient();
    await usingAttributes({ sessionId: 'session-1', userId: 'user-1' }, () =>
      observe({ name: 'triage' }, () => client.systemOne(request)),
    );

    const spans = typeSafeSpans();
    assert.equal(spans.length, 1);
    const span = spans[0];
    const parent = exporter.getFinishedSpans().find((s) => s.name === 'triage')!;
    assert.equal(span.parentSpanId, parent.spanContext().spanId);
    assert.equal(span.attributes['openinference.span.kind'], 'LLM');
    assert.equal(span.attributes['llm.model_name'], 'jev-1.13.0');
    assert.equal(span.attributes['llm.token_count.prompt'], 42);
    assert.equal(span.attributes['llm.token_count.completion'], 7);
    assert.equal(span.attributes['session.id'], 'session-1');
    assert.equal(span.attributes['user.id'], 'user-1');
  });

  it('records the model the API resolved, not the alias that was requested', async () => {
    const { client, calls } = makeClient();
    await client.systemOne({ ...request, model: 'jev-latest' });

    assert.equal(JSON.parse(String(calls[0].body)).model, 'jev-latest');
    const [span] = typeSafeSpans();
    assert.equal(span.attributes['llm.request.model_name'], 'jev-latest');
    assert.equal(span.attributes['llm.model_name'], 'jev-1.13.0');
  });

  it('keeps the attributes TraceRoot prices a Jev call from: LLM kind, model name, token counts', async () => {
    const { client } = makeClient();
    await client.systemOne(request);

    // TraceRoot ingest prices spans from these attributes.
    const [span] = typeSafeSpans();
    assert.equal(span.attributes['openinference.span.kind'], 'LLM');
    assert.equal(span.attributes['llm.model_name'], 'jev-1.13.0');
    assert.equal(span.attributes['llm.token_count.prompt'], 42);
    assert.equal(span.attributes['llm.token_count.completion'], 7);
  });

  it('marks a rejected call as an error span and rethrows the SDK error', async () => {
    const { client, calls } = makeClient(() =>
      Response.json({ message: 'State exceeds the maximum token count.' }, { status: 400 }),
    );
    const error = await client.systemOne(request).catch((e: unknown) => e);

    assert.ok(error instanceof typeSafe.BadRequestError);
    assert.equal(calls.length, 1);
    const spans = typeSafeSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
    assert.equal(spans[0].status.message, error.message);
    assert.equal(spans[0].attributes['http.response.status_code'], 400);
  });

  it('keeps SDK retries inside one span', async () => {
    const { client, calls } = makeClient(
      () => Response.json({ message: 'Service unavailable.' }, { status: 503 }),
      () => Response.json(result),
    );
    await client.systemOne(request, { retry: { maxRetries: 1, backoffInitialMs: 0 } });

    assert.equal(calls.length, 2);
    const spans = typeSafeSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].status.code, SpanStatusCode.OK);
  });

  it('returns the SDK APIPromise, so asResponse() still hands back an unread body', async () => {
    const { client } = makeClient();
    const promise = client.systemOne(request);
    assert.ok(promise instanceof typeSafe.APIPromise);

    const response = await promise.asResponse();
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), result);

    // On this path the span ends once the instrumentor has read its own clone of the body.
    for (let i = 0; i < 100 && typeSafeSpans().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(typeSafeSpans().length, 1);
    assert.equal(typeSafeSpans()[0].attributes['llm.token_count.prompt'], 42);
  });
});

function runScript(script: string, env: NodeJS.ProcessEnv = {}) {
  const pkgDir = process.cwd();
  const tsxLoader = pathToFileURL(
    path.join(pkgDir, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  ).href;
  return spawnSync(process.execPath, ['--import', tsxLoader, '-e', script], {
    cwd: pkgDir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// Makes one systemOne call in a fresh CommonJS process after TraceRoot.initialize() with the
// given instrumentModules source, and returns the attributes of each TypeSafe span TraceRoot
// would export. exportSpan records every span and drops it, so nothing leaves the process.
function typeSafeSpansAfterInitialize(
  instrumentModules: string,
  env: NodeJS.ProcessEnv = {},
): Record<string, unknown>[] {
  const result = runScript(
    `
      const { TraceRoot } = require('./src/traceroot.ts');
      const spans = [];
      TraceRoot.initialize({
        apiKey: 'test-key',
        disableBatch: true,
        ${instrumentModules}
        exportSpan: (span) => {
          spans.push(span);
          return false;
        },
      });
      const typeSafe = require('@typesafe-ai/sdk');
      const client = new typeSafe.TypeSafeClient({
        apiKey: 'test-key',
        logLevel: 'off',
        retry: { maxRetries: 0 },
        fetch: async () =>
          Response.json({
            model: 'jev-1.13.0',
            answers: { refund: { type: 'noul', noul: 0.88 } },
            usage: { input_tokens: 42, output_tokens: 7 },
          }),
      });
      client
        .systemOne({
          state: 'Customer card ending 4242 was charged twice.',
          questions: { refund: typeSafe.noul('Should this customer be refunded?') },
        })
        .then(() => {
          const typeSafeSpans = spans.filter((s) => s.name === '${SPAN_NAME}');
          console.log(JSON.stringify(typeSafeSpans.map((s) => s.attributes)));
        });
    `,
    env,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').pop()!);
}

describe('TypeSafe instrumentation through TraceRoot.initialize()', () => {
  it('records no TypeSafe span when instrumentModules is {}', () => {
    assert.deepEqual(typeSafeSpansAfterInitialize('instrumentModules: {},'), []);
  });

  it('redacts input.value but keeps the model and token counts with OPENINFERENCE_HIDE_INPUTS=true', () => {
    const spans = typeSafeSpansAfterInitialize(
      "instrumentModules: { typeSafe: require('@typesafe-ai/sdk') },",
      { OPENINFERENCE_HIDE_INPUTS: 'true' },
    );

    assert.equal(spans.length, 1);
    assert.equal(spans[0]['input.value'], '__REDACTED__');
    assert.ok(!JSON.stringify(spans[0]).includes('ending 4242'));
    assert.equal(spans[0]['llm.model_name'], 'jev-1.13.0');
    assert.equal(spans[0]['llm.token_count.prompt'], 42);
    assert.equal(spans[0]['llm.token_count.completion'], 7);
  });

  it('auto-instruments @typesafe-ai/sdk required after initialize() when instrumentModules is omitted', () => {
    const spans = typeSafeSpansAfterInitialize('');

    assert.equal(spans.length, 1);
    assert.equal(spans[0]['llm.model_name'], 'jev-1.13.0');
  });
});
