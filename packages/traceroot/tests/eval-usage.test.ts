// Per-case LLM usage: the bucket math and null rules, leaf-only counting, task vs scorer
// attribution, isolation between concurrent cases, and when capture counts as active.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_CONTEXT, trace, type Attributes, type Span } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  Emitter,
  EvalRunResult,
  FakeTransport,
  evaluate,
  makeRunResult,
  runSuite,
} from '../src/eval';
import {
  CaseUsageRecorder,
  collector,
  emptyBucket,
  sumUsage,
  withUsageScope,
  type CaseUsage,
  type UsageBucket,
} from '../src/eval/usage';
import { TraceRoot, _resetForTesting } from '../src/traceroot';

// The bucket's keys, in the order both SDKs write them: each sum, then the calls it covers.
const BUCKET_KEYS = [
  'llm_calls',
  'input_tokens',
  'llm_calls_with_input_tokens',
  'output_tokens',
  'llm_calls_with_output_tokens',
  'total_tokens',
  'llm_calls_with_total_tokens',
  'cache_read_tokens',
  'llm_calls_with_cache_read_tokens',
  'cache_write_tokens',
  'llm_calls_with_cache_write_tokens',
  'reasoning_tokens',
  'llm_calls_with_reasoning_tokens',
  'cost',
  'llm_calls_with_cost',
  'currency',
];

const SUM_FIELDS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'cost',
] as const;

/** A count is 0 exactly when its sum is null, and never above llm_calls. */
function assertCoverage(b: UsageBucket): void {
  for (const field of SUM_FIELDS) {
    const count = b[`llm_calls_with_${field}` as keyof UsageBucket] as number;
    assert.equal(count === 0, b[field] === null, `${field}: count ${count}, sum ${b[field]}`);
    assert.ok(count <= b.llm_calls, `${field}: ${count} calls of ${b.llm_calls}`);
  }
}

// A provider that is never registered globally: these tests hand it explicit parent contexts.
const provider = new BasicTracerProvider();
provider.addSpanProcessor(collector);
const tracer = provider.getTracer('usage-test');

function span(attrs: Attributes, parent?: Span, name = 'span'): Span {
  const ctx = parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
  return tracer.startSpan(name, { attributes: attrs }, ctx);
}

function llm(attrs: Attributes = {}, parent?: Span): Span {
  return span({ 'openinference.span.kind': 'LLM', ...attrs }, parent, 'llm');
}

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return { ...emptyBucket(), ...overrides };
}

/** A bucket whose every call reported input and output, so each has a total too. */
function reported(calls: number, input: number, output: number): UsageBucket {
  return bucket({
    llm_calls: calls,
    input_tokens: input,
    llm_calls_with_input_tokens: calls,
    output_tokens: output,
    llm_calls_with_output_tokens: calls,
    total_tokens: input + output,
    llm_calls_with_total_tokens: calls,
  });
}

describe('usage buckets', () => {
  it('sums each field over the calls that reported it, null when none did', async () => {
    const rec = new CaseUsageRecorder();
    withUsageScope(rec, 'task', () => {
      llm({
        'llm.token_count.prompt': 10,
        'llm.token_count.completion': 5,
        'llm.token_count.total': 15,
        'llm.token_count.prompt_details.cache_read': 3,
      }).end();
      // gen_ai.* only, no total reported: the total is input + output.
      llm({
        'gen_ai.usage.input_tokens': 7,
        'gen_ai.usage.output_tokens': 2,
        'llm.cost.total': 0.25,
      }).end();
      // A call that reported nothing still counts as a call.
      llm().end();
    });
    const usage = await rec.finish();
    assert.deepEqual(Object.keys(usage), ['task', 'scorers']);
    assert.deepEqual(Object.keys(usage.task), BUCKET_KEYS);
    assert.deepEqual(
      usage.task,
      bucket({
        llm_calls: 3,
        input_tokens: 17,
        llm_calls_with_input_tokens: 2,
        output_tokens: 7,
        llm_calls_with_output_tokens: 2,
        total_tokens: 24,
        llm_calls_with_total_tokens: 2,
        cache_read_tokens: 3,
        llm_calls_with_cache_read_tokens: 1,
        cost: 0.25,
        llm_calls_with_cost: 1,
        currency: 'USD',
      }),
    );
    assertCoverage(usage.task);
    assert.deepEqual(
      usage.scorers,
      emptyBucket(),
      'a role with no calls is zero calls, null tokens',
    );
    assertCoverage(usage.scorers);
  });

  it('counts the calls behind each sum: a call with input only covers no output or total', async () => {
    const rec = new CaseUsageRecorder();
    withUsageScope(rec, 'task', () => {
      llm({ 'llm.token_count.prompt': 100 }).end();
      llm({
        'llm.token_count.prompt': 20,
        'llm.token_count.completion': 8,
        'llm.token_count.total': 28,
      }).end();
    });
    const { task } = await rec.finish();
    assert.deepEqual(
      task,
      bucket({
        llm_calls: 2,
        input_tokens: 120,
        llm_calls_with_input_tokens: 2,
        output_tokens: 8,
        llm_calls_with_output_tokens: 1,
        total_tokens: 28,
        llm_calls_with_total_tokens: 1,
      }),
    );
    assertCoverage(task);
  });

  it('counts each detail field on its own', async () => {
    const rec = new CaseUsageRecorder();
    withUsageScope(rec, 'task', () => {
      llm({
        'llm.token_count.prompt': 50,
        'llm.token_count.prompt_details.cache_read': 30,
        'llm.token_count.completion_details.reasoning': 4,
      }).end();
      llm({
        'llm.token_count.prompt': 60,
        'llm.token_count.prompt_details.cache_write': 12,
        'llm.token_count.completion_details.reasoning': 6,
        'llm.cost.total': 0.01,
      }).end();
      llm({ 'llm.token_count.prompt_details.cache_read': 5 }).end();
    });
    const { task } = await rec.finish();
    assert.deepEqual(
      task,
      bucket({
        llm_calls: 3,
        input_tokens: 110,
        llm_calls_with_input_tokens: 2,
        cache_read_tokens: 35,
        llm_calls_with_cache_read_tokens: 2,
        cache_write_tokens: 12,
        llm_calls_with_cache_write_tokens: 1,
        reasoning_tokens: 10,
        llm_calls_with_reasoning_tokens: 2,
        cost: 0.01,
        llm_calls_with_cost: 1,
        currency: 'USD',
      }),
    );
    assertCoverage(task);
  });

  it('first present convention wins, and an invalid value counts as absent', async () => {
    const rec = new CaseUsageRecorder();
    withUsageScope(rec, 'task', () => {
      llm({
        'llm.token_count.prompt': 10,
        'gen_ai.usage.input_tokens': 99,
        'ai.usage.promptTokens': 1000,
        'llm.token_count.completion': -3, // negative: absent, falls through
        'gen_ai.usage.output_tokens': 4.5, // float: rounded half up
        'llm.token_count.total': Number.POSITIVE_INFINITY, // non-finite: absent
        'llm.token_count.prompt_details.cache_write': '5', // not a number: absent
        'llm.token_count.prompt_details.cache_creation': 6,
        'llm.token_count.completion_details.reasoning': 2.5,
        'llm.cost.total': -1,
      }).end();
    });
    const { task } = await rec.finish();
    assert.deepEqual(
      task,
      bucket({
        llm_calls: 1,
        input_tokens: 10,
        llm_calls_with_input_tokens: 1,
        output_tokens: 5,
        llm_calls_with_output_tokens: 1,
        total_tokens: 15,
        llm_calls_with_total_tokens: 1,
        cache_write_tokens: 6,
        llm_calls_with_cache_write_tokens: 1,
        reasoning_tokens: 3,
        llm_calls_with_reasoning_tokens: 1,
      }),
    );
    assertCoverage(task);
  });

  it('reads the remaining fallbacks: cache tokens from gen_ai.*, a reported total alone', async () => {
    const rec = new CaseUsageRecorder();
    withUsageScope(rec, 'task', () => {
      llm({
        'gen_ai.usage.cache_read_input_tokens': 8,
        'gen_ai.usage.cache_creation_input_tokens': 9,
        'llm.token_count.total': 40,
      }).end();
      llm({ 'llm.token_count.prompt': 3 }).end(); // input only: no derived total
    });
    const { task } = await rec.finish();
    assert.deepEqual(
      task,
      bucket({
        llm_calls: 2,
        input_tokens: 3,
        llm_calls_with_input_tokens: 1,
        total_tokens: 40,
        llm_calls_with_total_tokens: 1,
        cache_read_tokens: 8,
        llm_calls_with_cache_read_tokens: 1,
        cache_write_tokens: 9,
        llm_calls_with_cache_write_tokens: 1,
      }),
    );
    assertCoverage(task);
  });

  it('a run sums its cases, counts included; a sum stays null only when null in every case', () => {
    const a: CaseUsage = {
      task: bucket({
        llm_calls: 2,
        input_tokens: 5,
        llm_calls_with_input_tokens: 2,
        output_tokens: 1,
        llm_calls_with_output_tokens: 1,
        reasoning_tokens: 2,
        llm_calls_with_reasoning_tokens: 1,
      }),
      scorers: emptyBucket(),
    };
    const b: CaseUsage = {
      task: bucket({
        llm_calls: 3,
        input_tokens: 7,
        llm_calls_with_input_tokens: 1,
        cache_read_tokens: 4,
        llm_calls_with_cache_read_tokens: 2,
      }),
      scorers: bucket({
        llm_calls: 1,
        input_tokens: 4,
        llm_calls_with_input_tokens: 1,
        cost: 0.5,
        llm_calls_with_cost: 1,
        currency: 'USD',
      }),
    };
    const total = sumUsage([a, b])!;
    assert.deepEqual(total, {
      task: bucket({
        llm_calls: 5,
        input_tokens: 12,
        llm_calls_with_input_tokens: 3,
        output_tokens: 1,
        llm_calls_with_output_tokens: 1,
        cache_read_tokens: 4,
        llm_calls_with_cache_read_tokens: 2,
        reasoning_tokens: 2,
        llm_calls_with_reasoning_tokens: 1,
      }),
      scorers: bucket({
        llm_calls: 1,
        input_tokens: 4,
        llm_calls_with_input_tokens: 1,
        cost: 0.5,
        llm_calls_with_cost: 1,
        currency: 'USD',
      }),
    });
    assert.deepEqual(Object.keys(total.task), BUCKET_KEYS);
    assertCoverage(total.task);
    assertCoverage(total.scorers);
    assert.equal(sumUsage([null, undefined]), null, 'not captured in any case');
    assert.equal(sumUsage([]), null);
  });
});

describe('what counts as an LLM call', () => {
  it('counts only leaf LLM spans: a wrapper with an LLM descendant is not counted', async () => {
    const rec = new CaseUsageRecorder();
    withUsageScope(rec, 'task', () => {
      const wrapper = llm({ 'llm.token_count.prompt': 100, 'llm.token_count.completion': 10 });
      const chain = span({ 'openinference.span.kind': 'CHAIN' }, wrapper);
      const call = llm({ 'llm.token_count.prompt': 100, 'llm.token_count.completion': 10 }, chain);
      // End order does not matter: the wrapper ends first here.
      wrapper.end();
      call.end();
      chain.end();
      llm({ 'llm.token_count.prompt': 1, 'llm.token_count.completion': 1 }).end();
    });
    const { task } = await rec.finish();
    assert.equal(task.llm_calls, 2);
    assert.equal(task.input_tokens, 101);
    assert.equal(task.output_tokens, 11);
  });

  it('never counts AGENT / CHAIN / TOOL spans, even with aggregate tokens', async () => {
    const rec = new CaseUsageRecorder();
    withUsageScope(rec, 'task', () => {
      const agent = span({ 'openinference.span.kind': 'AGENT', 'llm.token_count.prompt': 500 });
      span({ 'openinference.span.kind': 'TOOL', 'llm.token_count.prompt': 9 }, agent).end();
      span({ 'openinference.span.kind': 'CHAIN', 'llm.token_count.prompt': 9 }, agent).end();
      llm({ 'llm.token_count.prompt': 20 }, agent).end();
      agent.end();
    });
    const { task } = await rec.finish();
    assert.equal(task.llm_calls, 1);
    assert.equal(task.input_tokens, 20);
  });

  it('reads a Vercel AI SDK provider call from its operation name and ai.usage.* tokens', async () => {
    const rec = new CaseUsageRecorder();
    withUsageScope(rec, 'task', () => {
      // As the AI SDK emits them, before any export-side mapping: the generateText span aggregates
      // the usage of its doGenerate children and must not be counted.
      const outer = span({
        'operation.name': 'ai.generateText my-fn',
        'ai.usage.promptTokens': 50,
        'ai.usage.completionTokens': 6,
      });
      span(
        {
          'operation.name': 'ai.generateText.doGenerate my-fn',
          'ai.usage.promptTokens': 30,
          'ai.usage.completionTokens': 4,
        },
        outer,
      ).end();
      span(
        {
          'operation.name': 'ai.generateText.doGenerate my-fn',
          'ai.usage.inputTokens': 20,
          'ai.usage.outputTokens': 2,
        },
        outer,
      ).end();
      span({ 'operation.name': 'ai.toolCall my-fn' }, outer).end();
      outer.end();
    });
    const { task } = await rec.finish();
    assert.deepEqual(task, reported(2, 50, 6));
  });
});

describe('attribution', () => {
  it('splits task calls from scorer calls and ignores calls made outside any scope', async () => {
    const rec = new CaseUsageRecorder();
    llm({ 'llm.token_count.prompt': 1000 }).end(); // before the case: not counted
    withUsageScope(rec, 'task', () => llm({ 'llm.token_count.prompt': 1 }).end());
    withUsageScope(rec, 'scorer', () => llm({ 'llm.token_count.prompt': 2 }).end());
    withUsageScope(rec, 'scorer', () => llm({ 'llm.token_count.prompt': 3 }).end());
    llm({ 'llm.token_count.prompt': 1000 }).end(); // between scopes: not counted
    const usage = await rec.finish();
    assert.equal(usage.task.llm_calls, 1);
    assert.equal(usage.task.input_tokens, 1);
    assert.equal(usage.scorers.llm_calls, 2);
    assert.equal(usage.scorers.input_tokens, 5);
  });

  it('a span that has not ended when the case closes is not counted, nor one started after', async () => {
    const rec = new CaseUsageRecorder();
    let late: Span | undefined;
    await withUsageScope(rec, 'task', async () => {
      llm({ 'llm.token_count.prompt': 1 }).end();
      late = llm({ 'llm.token_count.prompt': 50 });
    });
    const usage = await rec.finish();
    late!.end();
    withUsageScope(rec, 'task', () => llm({ 'llm.token_count.prompt': 70 }).end());
    assert.equal(usage.task.llm_calls, 1);
    assert.equal((await rec.finish()).task.llm_calls, 1, 'nothing recorded after close');
  });

  it('keeps each concurrent scope to its own case', async () => {
    const a = new CaseUsageRecorder();
    const b = new CaseUsageRecorder();
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const work = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await pause(1);
        const s = llm({ 'llm.token_count.prompt': n });
        await pause(1);
        s.end();
      }
    };
    await Promise.all([
      withUsageScope(a, 'task', () => work(3)),
      withUsageScope(b, 'task', () => work(5)),
    ]);
    assert.equal((await a.finish()).task.input_tokens, 9);
    assert.equal((await b.finish()).task.input_tokens, 25);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the engine: the runner arms capture and the eval module's initialize() wires an
// integration. The integration here is a stand-in whose wiring touches nothing; LLM spans are
// created on the global tracer as an instrumentation would.

const STUB_INTEGRATION = { openaiAgents: { setTraceProcessors: () => {} } };
const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

function armLocalCapture(instrumentModules: Record<string, unknown> = STUB_INTEGRATION): void {
  process.env['TRACEROOT_ENABLED'] = 'false';
  TraceRoot._armUsageCapture();
  TraceRoot.initialize({ instrumentModules });
}

/** An LLM call on the global tracer, as an auto-instrumentation makes it. */
async function globalLlmCall(prompt: number, completion = 1): Promise<Span> {
  const s = trace.getTracer('app').startSpan('llm', {
    attributes: {
      'openinference.span.kind': 'LLM',
      'llm.token_count.prompt': prompt,
      'llm.token_count.completion': completion,
    },
  });
  await new Promise((r) => setTimeout(r, 1));
  s.end();
  return s;
}

function globalDelegate(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gp = trace.getTracerProvider() as any;
  return typeof gp.getDelegate === 'function' ? gp.getDelegate() : gp;
}

beforeEach(() => {
  _resetForTesting();
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_ENABLED'];
  fetchCalls = [];
  globalThis.fetch = ((input: unknown, ...rest: unknown[]) => {
    fetchCalls.push(String(input));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realFetch as any)(input, ...rest);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_ENABLED'];
  _resetForTesting();
});

describe('engine: local runs', () => {
  it('records each case without leaking between concurrent cases', async () => {
    armLocalCapture();
    const calls: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 };
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await evaluate({
      name: 'concurrent',
      local: true,
      maxConcurrency: 2,
      dataset: Object.keys(calls).map((id) => ({ id, input: id })),
      task: async (input) => {
        const id = input as string;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        for (let i = 0; i < calls[id]; i++) {
          await new Promise((r) => setTimeout(r, 5 - calls[id]));
          await globalLlmCall(calls[id]);
        }
        inFlight -= 1;
        return id;
      },
      scorers: [
        async function judged() {
          await globalLlmCall(100, 2);
          return 1;
        },
      ],
    });
    assert.equal(maxInFlight, 2, 'cases ran concurrently');
    for (const item of result.itemResults) {
      const n = calls[item.caseId];
      assert.deepEqual(item.usage, {
        task: reported(n, n * n, n),
        scorers: reported(1, 100, 2),
      });
    }
    assert.deepEqual(fetchCalls, [], 'a local run makes no network call');
  });

  it('keeps the calls a task made before it threw', async () => {
    armLocalCapture();
    const result = await evaluate({
      name: 'threw',
      local: true,
      dataset: [{ id: 'x', input: 1 }],
      task: async () => {
        await globalLlmCall(12, 3);
        throw new Error('boom');
      },
      scorers: [() => 1],
    });
    const [item] = result.itemResults;
    assert.match(item.error ?? '', /boom/);
    assert.equal(item.usage?.task.llm_calls, 1);
    assert.equal(item.usage?.task.input_tokens, 12);
    assert.deepEqual(item.usage?.scorers, emptyBucket(), 'scorers do not run after a task error');
  });

  it('records through an exporter-less provider whose only processor is the collector', async () => {
    armLocalCapture();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = globalDelegate() as any;
    assert.deepEqual(delegate._registeredSpanProcessors, [collector]);
    assert.equal(TraceRoot.isInitialized(), false, 'the exporting client stays uninitialized');
    let recording: boolean | undefined;
    const result = await evaluate({
      name: 'capture',
      local: true,
      dataset: [{ id: 'x', input: 1 }],
      task: () => {
        const s = trace.getTracer('app').startSpan('llm', {
          attributes: { 'openinference.span.kind': 'LLM', 'llm.token_count.prompt': 1 },
        });
        recording = s.isRecording();
        s.end();
        return 1;
      },
      scorers: [() => 1],
    });
    assert.equal(recording, true, 'the local run records spans in-process');
    assert.equal(result.itemResults[0].usage?.task.llm_calls, 1);
    assert.deepEqual(fetchCalls, []);
  });

  it('is null when the eval module opts out with enabled: false', async () => {
    process.env['TRACEROOT_ENABLED'] = 'false';
    TraceRoot._armUsageCapture();
    TraceRoot.initialize({ enabled: false, instrumentModules: STUB_INTEGRATION });
    assert.notEqual(globalDelegate() instanceof BasicTracerProvider, true, 'no capture provider');
    const result = await evaluate({
      name: 'opted-out',
      local: true,
      dataset: [{ id: 'x', input: 1 }],
      task: async () => {
        await globalLlmCall(5);
        return 1;
      },
      scorers: [() => 1],
    });
    assert.equal(result.itemResults[0].usage, null);
  });

  it('is null when only a non-LLM integration was wired', async () => {
    armLocalCapture({ typeSafe: { TypeSafeClient: class {} } });
    assert.equal(TraceRoot._usageCaptured(true), false);
  });

  it('is null, not zero, when the run was not armed (no capture provider)', async () => {
    const result = await evaluate({
      name: 'unarmed',
      local: true,
      dataset: [{ id: 'x', input: 1 }],
      task: async () => {
        await globalLlmCall(5);
        return 1;
      },
      scorers: [() => 1],
    });
    assert.equal(result.itemResults[0].usage, null);
  });

  it('is null and the run stays suppressed when no integration was wired', async () => {
    armLocalCapture({});
    let recording: boolean | undefined;
    const result = await evaluate({
      name: 'unwired',
      local: true,
      dataset: [{ id: 'x', input: 1 }],
      task: () => {
        const s = trace.getTracer('app').startSpan('llm');
        recording = s.isRecording();
        s.end();
        return 1;
      },
      scorers: [() => 1],
    });
    assert.equal(result.itemResults[0].usage, null);
    assert.equal(recording, false, 'spans under a local run without capture are suppressed');
  });

  it('is null and the run stays suppressed when another provider owns the global slot', async () => {
    const other = new BasicTracerProvider();
    const seen: string[] = [];
    const spy: SpanProcessor = {
      onStart: () => {},
      onEnd: (s: ReadableSpan) => void seen.push(s.name),
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    other.addSpanProcessor(spy);
    trace.setGlobalTracerProvider(other);
    armLocalCapture();
    assert.equal(globalDelegate(), other);
    const result = await evaluate({
      name: 'taken',
      local: true,
      dataset: [{ id: 'x', input: 1 }],
      task: async () => {
        await globalLlmCall(5);
        return 1;
      },
      scorers: [() => 1],
    });
    assert.equal(result.itemResults[0].usage, null);
    assert.deepEqual(seen, [], 'the other provider received nothing from the local run');
  });
});

describe('engine: uploaded runs', () => {
  it('reads usage through the exporting provider without changing what it exports', async () => {
    const exported: string[] = [];
    TraceRoot.initialize({
      apiKey: 'dummy-key',
      baseUrl: 'http://127.0.0.1:9',
      disableBatch: true,
      instrumentModules: STUB_INTEGRATION,
      // Drop every span at the export boundary (after recording its name): nothing is sent.
      exportSpan: (s) => {
        exported.push(s.name);
        return false;
      },
    });
    const result = await evaluate({
      name: 'uploaded',
      dataset: [{ id: 'x', input: 1 }],
      transport: new FakeTransport(),
      task: async () => {
        await globalLlmCall(7, 2);
        return 1;
      },
      scorers: [() => 1],
    });
    assert.deepEqual(result.itemResults[0].usage?.task, reported(1, 7, 2));
    assert.ok(exported.includes('llm'), 'the LLM span still reached the export path');
    assert.ok(exported.includes('evaluation-item'));
  });

  it('is null when the exporting provider has no integration wired', async () => {
    TraceRoot.initialize({
      apiKey: 'dummy-key',
      baseUrl: 'http://127.0.0.1:9',
      disableBatch: true,
      instrumentModules: {},
      exportSpan: () => false,
    });
    const result = await evaluate({
      name: 'uploaded-unwired',
      dataset: [{ id: 'x', input: 1 }],
      transport: new FakeTransport(),
      task: async () => {
        await globalLlmCall(7);
        return 1;
      },
      scorers: [() => 1],
    });
    assert.equal(result.itemResults[0].usage, null);
  });
});

describe('reading artifacts back', () => {
  it('an artifact without usage reads as null; one with usage keeps it', () => {
    const usage: CaseUsage = {
      task: bucket({ llm_calls: 1, input_tokens: 3, llm_calls_with_input_tokens: 1 }),
      scorers: emptyBucket(),
    };
    const runDoc = (u?: CaseUsage) => ({
      kind: 'eval_run',
      evaluation_name: 'e',
      cases: [{ case_id: 'a', scores: [], scorer_errors: [], ...(u ? { usage: u } : {}) }],
    });
    assert.equal(EvalRunResult.fromJSON(runDoc()).itemResults[0].usage, null);
    assert.deepEqual(EvalRunResult.fromJSON(runDoc(usage)).itemResults[0].usage, usage);
    const saved = { name: 'e', item_results: [{ case_id: 'a', scores: [] }] };
    assert.equal(EvalRunResult.fromJSON(saved).itemResults[0].usage, null);
    assert.equal(EvalRunResult.fromJSON(saved).usage, null);
  });

  it('save() writes usage per case and for the run, and load() reads both back', async () => {
    armLocalCapture();
    const result = await evaluate({
      name: 'saved',
      local: true,
      dataset: [
        { id: 'a', input: 2 },
        { id: 'b', input: 3 },
      ],
      task: async (input) => {
        await globalLlmCall(input as number);
        return 1;
      },
      scorers: [() => 1],
    });
    const path = join(mkdtempSync(join(tmpdir(), 'usage-save-')), 'run.json');
    result.save(path);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(raw.usage.task.input_tokens, 5);
    assert.equal(raw.item_results[0].usage.task.input_tokens, 2);
    const loaded = EvalRunResult.load(path);
    assert.deepEqual(loaded.usage, result.usage);
    assert.deepEqual(
      loaded.itemResults.map((it) => it.usage),
      result.itemResults.map((it) => it.usage),
    );
  });
});

describe('a run with no finished case', () => {
  it('has zero calls when capture was active, null when it was not', () => {
    const zero = { task: emptyBucket(), scorers: emptyBucket() };
    const ok = { status: 'uploaded' as const, dashboardUrl: null };
    assert.deepEqual(makeRunResult('r', [], ok, { usageCaptured: true }).usage, zero);
    assert.equal(makeRunResult('r', [], ok, { usageCaptured: false }).usage, null);
    assert.equal(makeRunResult('r', [], ok).usage, null);
  });

  // A run cancelled before any case finished goes through the runner's partial-result path.
  const cancelledRunUsage = async (initialize: string): Promise<Record<string, unknown>[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-cancel-'));
    const evalFile = join(dir, 'cancel_eval.ts');
    const src = join(__dirname, '..', 'src').replace(/\\/g, '/');
    writeFileSync(
      evalFile,
      `import { TraceRoot } from '${src}/traceroot';
       import { Evaluation } from '${src}/eval';
       ${initialize}
       export const e = new Evaluation({ name: 'cancelled', dataset: [{ id: 'a', input: 1 }],
         task: () => 1, scorers: [() => 1] });`,
    );
    const controller = new AbortController();
    controller.abort();
    const events: Record<string, unknown>[] = [];
    await runSuite(
      [evalFile],
      { reporting: false, out_dir: join(dir, 'runs') },
      new Emitter((ln) => events.push(JSON.parse(ln))),
      controller.signal,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const done = events.find((e) => e.type === 'evaluation_completed') as Record<string, any>;
    assert.equal(done.status, 'incomplete');
    assert.equal(done.counts.cases, 0);
    const runDoc = JSON.parse(readFileSync(done.artifact.run, 'utf8'));
    return [done.usage, runDoc.usage];
  };

  it('a cancelled run writes zero calls when capture was active', async () => {
    const zero = { task: emptyBucket(), scorers: emptyBucket() };
    const [event, runDoc] = await cancelledRunUsage(
      `TraceRoot.initialize({ instrumentModules: { openaiAgents: { setTraceProcessors() {} } } });`,
    );
    assert.deepEqual(event, zero);
    assert.deepEqual(runDoc, zero);
  });

  it('a cancelled run writes null when capture was not active', async () => {
    const [event, runDoc] = await cancelledRunUsage('');
    assert.equal(event, null);
    assert.equal(runDoc, null);
  });
});
