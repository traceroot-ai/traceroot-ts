import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as genai from '@google/genai';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { instrumentGoogleGenAI } from '../src/google-genai';

// The real SDK, with only the network replaced.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

const realFetch = globalThis.fetch;
let replies: Response[] = [];

const usage = {
  promptTokenCount: 11,
  candidatesTokenCount: 7,
  thoughtsTokenCount: 3,
  cachedContentTokenCount: 4,
  totalTokenCount: 21,
};

function body(parts: unknown[], extra: object = {}) {
  return {
    candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
    modelVersion: 'gemini-2.5-flash-001',
    usageMetadata: usage,
    ...extra,
  };
}

const reply = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const streamReply = (...chunks: unknown[]) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const client = () => new genai.GoogleGenAI({ apiKey: 'test-key', vertexai: false });

function onlySpan(): ReadableSpan {
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  return spans[0]!;
}

before(() => {
  provider.register();
  assert.equal(instrumentGoogleGenAI(genai), true);
  // A second call must not wrap the wrappers.
  assert.equal(instrumentGoogleGenAI(genai), true);
  globalThis.fetch = async () => {
    const next = replies.shift();
    assert.ok(next, 'unexpected request');
    return next;
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
  replies = [];
});

describe('@google/genai instrumentation', () => {
  it('records one LLM span with messages, model, parameters and usage', async () => {
    replies = [reply(body([{ text: 'hidden', thought: true }, { text: 'Blue.' }]))];

    const response = await client().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Why is the sky blue?',
      config: { systemInstruction: 'Be brief.', temperature: 0.2 },
    });

    assert.equal(response.text, 'Blue.');
    const { name, attributes, status } = onlySpan();
    assert.equal(name, 'Google GenAI Generate Content');
    assert.equal(status.code, 1);
    assert.equal(attributes['openinference.span.kind'], 'LLM');
    assert.equal(attributes['llm.provider'], 'google');
    assert.equal(attributes['llm.model_name'], 'gemini-2.5-flash-001');
    assert.equal(attributes['llm.input_messages.0.message.role'], 'system');
    assert.equal(attributes['llm.input_messages.0.message.content'], 'Be brief.');
    assert.equal(attributes['llm.input_messages.1.message.role'], 'user');
    assert.equal(attributes['llm.input_messages.1.message.content'], 'Why is the sky blue?');
    assert.equal(attributes['llm.output_messages.0.message.role'], 'assistant');
    assert.equal(attributes['llm.output_messages.0.message.content'], 'Blue.');
    assert.deepEqual(JSON.parse(String(attributes['llm.invocation_parameters'])), {
      temperature: 0.2,
    });
    assert.equal(attributes['llm.token_count.prompt'], 11);
    assert.equal(attributes['llm.token_count.completion'], 10);
    assert.equal(attributes['llm.token_count.total'], 21);
    assert.equal(attributes['llm.token_count.prompt_details.cache_read'], 4);
    assert.equal(attributes['llm.token_count.completion_details.reasoning'], 3);
  });

  it('leaves inline file bytes and transport headers out of the span', async () => {
    replies = [reply(body([{ text: 'A cat.' }]))];

    await client().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ inlineData: { mimeType: 'image/png', data: 'QUJD'.repeat(500) } }, 'What?'],
      config: { httpOptions: { headers: { authorization: 'Bearer secret-token' } } },
    });

    const recorded = JSON.stringify(onlySpan().attributes);
    assert.ok(!recorded.includes('QUJDQUJD'));
    assert.ok(recorded.includes('[2000 base64 chars]'));
    assert.ok(!recorded.includes('secret-token'));
  });

  it('assembles a stream into one span, passing every chunk through', async () => {
    replies = [
      streamReply(
        body([{ text: 'The sky ' }], { usageMetadata: { promptTokenCount: 11 } }),
        body([{ text: 'is blue.' }]),
      ),
    ];

    const stream = await client().models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: 'Why?',
    });
    const seen: string[] = [];
    for await (const chunk of stream) seen.push(chunk.text ?? '');

    assert.deepEqual(seen, ['The sky ', 'is blue.']);
    const { name, attributes } = onlySpan();
    assert.equal(name, 'Google GenAI Generate Content Stream');
    assert.equal(attributes['llm.output_messages.0.message.content'], 'The sky is blue.');
    assert.equal(attributes['llm.token_count.total'], 21);
  });

  it('ends the span with what arrived when the consumer stops early', async () => {
    replies = [streamReply(body([{ text: 'first' }]), body([{ text: 'second' }]))];

    const stream = await client().models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: 'Go',
    });
    for await (const _chunk of stream) break;

    assert.equal(onlySpan().attributes['llm.output_messages.0.message.content'], 'first');
  });

  it('traces chat turns with their history', async () => {
    replies = [reply(body([{ text: 'Hi.' }])), reply(body([{ text: 'Fine.' }]))];
    const chat = client().chats.create({ model: 'gemini-2.5-flash' });

    await chat.sendMessage({ message: 'Hello' });
    await chat.sendMessage({ message: 'How are you?' });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    assert.equal(spans[1]!.attributes['llm.input_messages.1.message.role'], 'assistant');
    assert.equal(spans[1]!.attributes['llm.input_messages.2.message.content'], 'How are you?');
  });

  it('traces every round of automatic function calling, with the tool messages', async () => {
    const call = { functionCall: { name: 'weather', args: { city: 'Pune' } } };
    replies = [reply(body([call])), reply(body([{ text: 'Sunny.' }]))];
    const weather: genai.CallableTool = {
      tool: async () => ({ functionDeclarations: [{ name: 'weather' }] }),
      callTool: async () => [{ functionResponse: { name: 'weather', response: { sky: 'sunny' } } }],
    };

    await client().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Weather in Pune?',
      config: { tools: [weather] },
    });

    const [first, second] = exporter.getFinishedSpans();
    assert.equal(exporter.getFinishedSpans().length, 2);
    const prefix = 'llm.output_messages.0.message.tool_calls.0.tool_call.function';
    assert.equal(first!.attributes[`${prefix}.name`], 'weather');
    assert.equal(first!.attributes[`${prefix}.arguments`], '{"city":"Pune"}');
    assert.ok(String(first!.attributes['llm.tools.0.tool.json_schema']).includes('weather'));
    assert.equal(second!.attributes['llm.input_messages.2.message.role'], 'tool');
    assert.equal(second!.attributes['llm.input_messages.2.message.name'], 'weather');
    assert.equal(second!.attributes['llm.input_messages.2.message.content'], '{"sky":"sunny"}');
  });

  it('marks a failed request as an error and rethrows it', async () => {
    replies = [reply({ error: { code: 400, message: 'bad model' } }, 400)];

    await assert.rejects(
      client().models.generateContent({ model: 'nope', contents: 'x' }),
      /bad model/,
    );

    const { status, events, attributes } = onlySpan();
    assert.equal(status.code, 2);
    assert.equal(events[0]!.name, 'exception');
    assert.equal(attributes['llm.model_name'], 'nope');
  });

  it('records nothing while tracing is suppressed', async () => {
    replies = [reply(body([{ text: 'ok' }]))];

    await context.with(suppressTracing(context.active()), () =>
      client().models.generateContent({ model: 'gemini-2.5-flash', contents: 'x' }),
    );

    assert.equal(exporter.getFinishedSpans().length, 0);
  });

  it('declines anything but the module namespace', () => {
    assert.equal(instrumentGoogleGenAI(genai.GoogleGenAI), false);
  });
});
