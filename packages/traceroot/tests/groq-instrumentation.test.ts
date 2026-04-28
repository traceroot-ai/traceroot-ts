import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { GroqInstrumentation } from '../src/groq_instrumentation';
import { _resetForTesting } from '../src/traceroot';

describe('GroqInstrumentation', () => {
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

  it('creates an LLM span for Groq chat completions', async () => {
    class FakeGroqClient {
      async post(path: string, opts?: { body?: Record<string, unknown> }) {
        if (path !== '/openai/v1/chat/completions') {
          return { ok: true };
        }
        return {
          model: String(opts?.body?.model ?? 'llama-3.3-70b-versatile'),
          usage: { prompt_tokens: 12, completion_tokens: 5 },
          choices: [{ message: { content: 'Hello from Groq' } }],
        };
      }
    }

    const instr = new GroqInstrumentation();
    instr.manuallyInstrument({
      Groq: FakeGroqClient as unknown as { prototype: Record<string, unknown> },
    });

    const client = new FakeGroqClient();
    await client.post('/openai/v1/chat/completions', {
      body: {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'Say hello' }],
      },
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const span = spans[0];

    assert.equal(span.name, 'groq.chat.completions.create');
    assert.equal(span.attributes['openinference.span.kind'], 'LLM');
    assert.equal(span.attributes['llm.model_name'], 'llama-3.3-70b-versatile');
    assert.equal(span.attributes['llm.token_count.prompt'], 12);
    assert.equal(span.attributes['llm.token_count.completion'], 5);
    assert.equal(span.attributes['input.value'], 'Say hello');
    assert.equal(span.attributes['output.value'], 'Hello from Groq');
  });

  it('does not create a span for non-chat Groq post routes', async () => {
    class FakeGroqClient {
      async post(_path: string, _opts?: unknown) {
        return { ok: true };
      }
    }

    const instr = new GroqInstrumentation();
    instr.manuallyInstrument({
      Groq: FakeGroqClient as unknown as { prototype: Record<string, unknown> },
    });

    const client = new FakeGroqClient();
    await client.post('/openai/v1/embeddings', { body: { model: 'text-embedding' } });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 0);
  });

  it('does not throw on malformed messages payloads', async () => {
    class FakeGroqClient {
      async post(path: string, opts?: { body?: Record<string, unknown> }) {
        if (path !== '/openai/v1/chat/completions') {
          return { ok: true };
        }
        return {
          model: String(opts?.body?.model ?? 'llama-3.3-70b-versatile'),
          usage: { prompt_tokens: 7, completion_tokens: 3 },
          choices: [{ message: { content: 'Handled malformed input' } }],
        };
      }
    }

    const instr = new GroqInstrumentation();
    instr.manuallyInstrument({
      Groq: FakeGroqClient as unknown as { prototype: Record<string, unknown> },
    });

    const client = new FakeGroqClient();
    await client.post('/openai/v1/chat/completions', {
      body: {
        model: 'llama-3.3-70b-versatile',
        messages: [null, 42, 'bad', { nope: true }, { role: 'user', content: 'hello' }],
      },
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const span = spans[0];
    assert.equal(span.attributes['input.value'], 'hello');
  });
});
