// The LLM judge's own span must carry token counts on the default dispatch.
//
// When no provider integration traces the judge's model, the judge wraps its OWN llm span — and
// that span used to record the model with no usage at all, so the backend (which derives cost
// from the OpenInference token-count attributes on ingest) had nothing to price. The SDK never
// computes a dollar cost; it only has to EMIT the same `llm.token_count.*` attributes the
// auto-instrumentation emits, under byte-identical keys (parity with traceroot-py).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { _resetSpansState } from '../src/spans';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { __setInstrumentedProvidersForTest } from '../src/instrumentation';
import { _resetObserveState } from '../src/observe';
import { llmJudge, _setJudgeProviderImport } from '../src/eval/scorers';
import type { ScorerContext } from '../src/eval';

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  // Initialize up front so the judge's own lazy init is a no-op, then declare that NO provider
  // integration is active: these tests are about the path where the judge opens its own LLM span.
  TraceRoot.initialize();
  __setInstrumentedProvidersForTest([]);
});
afterEach(async () => {
  _setJudgeProviderImport(null);
  __setInstrumentedProvidersForTest([]);
  await provider.shutdown();
  exporter.reset();
  _resetForTesting();
  _resetObserveState();
  _resetSpansState();
});

const ctx = { input: 'q', output: 'a', expected: null } as unknown as ScorerContext;

function judgeSpan(name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((s) => s.name === `llm_judge:${name}`);
  assert.ok(span, `expected an llm_judge:${name} span`);
  return span;
}

/** Stand in for `@anthropic-ai/sdk` / `openai` so the default dispatch runs for real, offline. */
function fakeProvider(build: (calls: unknown[]) => unknown) {
  const calls: unknown[] = [];
  const respond = () => build(calls);
  return {
    calls,
    module: {
      default: class {
        messages = {
          create: async (req: unknown) => {
            calls.push(req);
            return respond();
          },
        };
        chat = {
          completions: {
            create: async (req: unknown) => {
              calls.push(req);
              return respond();
            },
          },
        };
      },
    },
  };
}

describe('the judge span carries token counts on the default dispatch', () => {
  it('anthropic usage lands on the judge span under the OpenInference keys', async () => {
    const fake = fakeProvider(() => ({
      content: [{ text: '0.75' }],
      usage: {
        input_tokens: 100,
        output_tokens: 7,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
    }));
    _setJudgeProviderImport(async () => fake.module);

    const judge = llmJudge({
      name: 'conciseness',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'ANSWER:\n{{output}}' }],
    });
    const score = await judge(ctx);

    assert.equal((score as { value: number }).value, 0.75);
    const attrs = judgeSpan('conciseness').attributes;
    // prompt counts the cached + created input the same way the SDK's own anthropic
    // instrumentation does, so one judge call prices identically either way.
    assert.equal(attrs['llm.token_count.prompt'], 125);
    assert.equal(attrs['llm.token_count.completion'], 7);
    assert.equal(attrs['llm.token_count.total'], 132);
    assert.equal(attrs['llm.token_count.prompt_details.cache_read'], 20);
    assert.equal(attrs['llm.token_count.prompt_details.cache_creation'], 5);
  });

  it('openai usage lands on the judge span too', async () => {
    const fake = fakeProvider(() => ({
      choices: [{ message: { content: '1' } }],
      usage: { prompt_tokens: 42, completion_tokens: 3, total_tokens: 45 },
    }));
    _setJudgeProviderImport(async () => fake.module);

    const judge = llmJudge({
      name: 'grade',
      model: 'gpt-5',
      messages: [{ role: 'user', content: '{{output}}' }],
    });
    await judge(ctx);
    const attrs = judgeSpan('grade').attributes;
    assert.equal(attrs['llm.token_count.prompt'], 42);
    assert.equal(attrs['llm.token_count.completion'], 3);
    assert.equal(attrs['llm.token_count.total'], 45);
    // No cache detail reported by the provider -> no cache attributes invented.
    assert.equal(attrs['llm.token_count.prompt_details.cache_read'], undefined);
    assert.equal(attrs['llm.token_count.prompt_details.cache_creation'], undefined);
  });

  it('a provider that reports no usage records no token attributes', async () => {
    const fake = fakeProvider(() => ({ content: [{ text: '0.5' }] }));
    _setJudgeProviderImport(async () => fake.module);

    const judge = llmJudge({
      name: 'nousage',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: '{{output}}' }],
    });
    await judge(ctx);
    const attrs = judgeSpan('nousage').attributes;
    for (const k of Object.keys(attrs)) assert.ok(!k.startsWith('llm.token_count.'), k);
  });

  it('a user-supplied complete (text only) still works and records no token attributes', async () => {
    const judge = llmJudge({
      name: 'stubbed',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: '{{output}}' }],
      complete: () => '0.25',
    });
    const score = await judge(ctx);

    assert.equal((score as { value: number }).value, 0.25);
    const span = judgeSpan('stubbed');
    for (const k of Object.keys(span.attributes)) {
      assert.ok(!k.startsWith('llm.token_count.'), k);
    }
    // The span is still the judge's LLM span: prompt in, response out.
    assert.match(String(span.attributes['output.value']), /0\.25/);
  });
});
