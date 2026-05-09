import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { MistralInstrumentation } from '../src/mistral';
import { _resetForTesting } from '../src/traceroot';

// Build a fake Mistral module shaped like @mistralai/mistralai v2:
//   class Chat { async complete(req) { ... } }
//   class Mistral { get chat() { return cached new Chat() } }
//
// Each call to `buildFakeMistralModule()` returns a fresh pair of classes so
// instrumentor state from prior tests can't bleed across.
function buildFakeMistralModule(completeImpl: (req: unknown) => Promise<unknown>): {
  Mistral: new () => { readonly chat: { complete: (req: unknown) => Promise<unknown> } };
} {
  class Chat {
    async complete(req: unknown): Promise<unknown> {
      return completeImpl(req);
    }
  }
  class Mistral {
    private _chat?: Chat;
    get chat(): Chat {
      return (this._chat ??= new Chat());
    }
  }
  return { Mistral } as unknown as {
    Mistral: new () => { readonly chat: { complete: (req: unknown) => Promise<unknown> } };
  };
}

describe('MistralInstrumentation', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    _resetForTesting();
  });

  it('creates an LLM span for mistral.chat.complete with full attributes', async () => {
    const fakeModule = buildFakeMistralModule(async (req) => {
      const r = req as { model: string; messages: unknown };
      return {
        id: 'cmpl-1',
        model: r.model,
        usage: { promptTokens: 17, completionTokens: 9, totalTokens: 26 },
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Bonjour from Mistral' },
            finishReason: 'stop',
          },
        ],
      };
    });

    const instr = new MistralInstrumentation();
    instr.manuallyInstrument(fakeModule);

    const client = new fakeModule.Mistral();
    const result = (await client.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'Say hello' }],
      temperature: 0.2,
      toolChoice: 'auto',
    })) as { choices: Array<{ message: { content: string } }> };

    assert.equal(result.choices[0].message.content, 'Bonjour from Mistral');

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const span = spans[0];

    assert.equal(span.name, 'mistral.chat.complete mistral-large-latest');
    assert.equal(span.attributes['openinference.span.kind'], 'LLM');
    assert.equal(span.attributes['llm.system'], 'mistralai');
    assert.equal(span.attributes['llm.provider'], 'mistralai');
    assert.equal(span.attributes['llm.model_name'], 'mistral-large-latest');
    assert.equal(span.attributes['llm.token_count.prompt'], 17);
    assert.equal(span.attributes['llm.token_count.completion'], 9);
    assert.equal(span.attributes['llm.token_count.total'], 26);
    assert.equal(span.attributes['input.value'], 'Say hello');
    assert.equal(span.attributes['input.mime_type'], 'text/plain');
    assert.equal(span.attributes['output.value'], 'Bonjour from Mistral');
    assert.equal(span.attributes['output.mime_type'], 'text/plain');
    assert.deepEqual(span.attributes['llm.response.finish_reasons'], ['stop']);

    // Invocation parameters should include non-message/non-model fields.
    const invocation = JSON.parse(span.attributes['llm.invocation_parameters'] as string) as {
      temperature?: number;
      toolChoice?: string;
      messages?: unknown;
      model?: unknown;
    };
    assert.equal(invocation.temperature, 0.2);
    assert.equal(invocation.toolChoice, 'auto');
    assert.equal('messages' in invocation, false);
    assert.equal('model' in invocation, false);
  });

  it('captures tool-call output when assistant returns toolCalls instead of text', async () => {
    const fakeModule = buildFakeMistralModule(async () => ({
      model: 'mistral-medium-latest',
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call_42',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
      ],
    }));

    const instr = new MistralInstrumentation();
    instr.manuallyInstrument(fakeModule);

    const client = new fakeModule.Mistral();
    await client.chat.complete({
      model: 'mistral-medium-latest',
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
    });

    const span = exporter.getFinishedSpans()[0];
    assert.equal(span.attributes['llm.model_name'], 'mistral-medium-latest');
    assert.deepEqual(span.attributes['llm.response.finish_reasons'], ['tool_calls']);

    const output = JSON.parse(span.attributes['output.value'] as string) as Array<{
      id: string;
      name: string;
      arguments: string;
    }>;
    assert.equal(output.length, 1);
    assert.equal(output[0].id, 'call_42');
    assert.equal(output[0].name, 'get_weather');
    assert.equal(output[0].arguments, '{"city":"Paris"}');
  });

  it('records exception and ERROR status when complete() rejects', async () => {
    const boom = new Error('Mistral API blew up');
    const fakeModule = buildFakeMistralModule(async () => {
      throw boom;
    });

    const instr = new MistralInstrumentation();
    instr.manuallyInstrument(fakeModule);

    const client = new fakeModule.Mistral();
    await assert.rejects(
      client.chat.complete({
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: 'fail please' }],
      }),
      /Mistral API blew up/,
    );

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const span = spans[0];

    // SpanStatusCode.ERROR === 2
    assert.equal(span.status.code, 2);
    assert.match(span.status.message ?? '', /Mistral API blew up/);
    assert.equal(span.events.length, 1);
    assert.equal(span.events[0].name, 'exception');
  });

  it('does not throw on malformed messages payloads', async () => {
    const fakeModule = buildFakeMistralModule(async (req) => {
      const r = req as { model: string };
      return {
        model: r.model,
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        choices: [{ message: { role: 'assistant', content: 'Handled malformed input' } }],
      };
    });

    const instr = new MistralInstrumentation();
    instr.manuallyInstrument(fakeModule);

    const client = new fakeModule.Mistral();
    await client.chat.complete({
      model: 'mistral-small-latest',
      messages: [null, 42, 'bad', { nope: true }, { role: 'user', content: 'hello' }],
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attributes['input.value'], 'hello');
    assert.equal(spans[0].attributes['output.value'], 'Handled malformed input');
  });

  it('only patches the Chat prototype once across multiple Mistral instances', async () => {
    let callCount = 0;
    const fakeModule = buildFakeMistralModule(async () => {
      callCount++;
      return {
        model: 'mistral-large-latest',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        choices: [{ message: { content: 'ok' }, finishReason: 'stop' }],
      };
    });

    const instr = new MistralInstrumentation();
    instr.manuallyInstrument(fakeModule);

    // Two distinct clients accessing chat repeatedly should still produce
    // exactly one span per call (no double-wrapping).
    const c1 = new fakeModule.Mistral();
    const c2 = new fakeModule.Mistral();
    await c1.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'a' }],
    });
    await c1.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'b' }],
    });
    await c2.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'c' }],
    });

    assert.equal(callCount, 3);
    assert.equal(exporter.getFinishedSpans().length, 3);
  });
});
