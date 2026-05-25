import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { wireClaudeAgentSDKInstrumentation } from '../src/claude-agent-sdk';

type HookInput = Record<string, unknown>;
type HookCallback = (input: HookInput, toolUseId?: string) => Promise<Record<string, unknown>>;
type QueryParams = {
  prompt?: string;
  options?: {
    model?: string;
    hooks?: Record<string, Array<{ hooks: HookCallback[] }>>;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spanDurationMs(span: { duration: [number, number] }): number {
  return span.duration[0] * 1000 + span.duration[1] / 1_000_000;
}

function spanStartMs(span: { startTime: [number, number] }): number {
  return span.startTime[0] * 1000 + span.startTime[1] / 1_000_000;
}

function spanEndMs(span: { duration: [number, number]; startTime: [number, number] }): number {
  return spanStartMs(span) + spanDurationMs(span);
}

async function runHooks(params: QueryParams, event: string, input: HookInput, toolUseId: string) {
  const matchers = params.options?.hooks?.[event] ?? [];
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      await hook({ ...input, hook_event_name: event, tool_use_id: toolUseId }, toolUseId);
    }
  }
}

async function exhaustQuery(
  sdk: { query(params: QueryParams): AsyncIterable<unknown> },
  params: QueryParams = { prompt: 'test prompt', options: { model: 'claude-opus-4-7' } },
): Promise<void> {
  for await (const _message of sdk.query(params)) {
    // Exhaust the stream.
  }
}

describe('Claude Agent SDK instrumentation', () => {
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
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('emits a bare Claude Agent SDK tree with models and cache tokens', async () => {
    const sdk = {
      async *query(params: QueryParams) {
        await sleep(5);
        yield {
          type: 'assistant',
          message: {
            id: 'msg_main_1',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 30,
            },
            content: [
              {
                type: 'tool_use',
                id: 'toolu_agent_1',
                name: 'Agent',
                input: { subagent_type: 'researcher' },
              },
            ],
          },
        };

        await sleep(5);
        await runHooks(
          params,
          'PreToolUse',
          {
            tool_name: 'Agent',
            tool_input: { subagent_type: 'researcher' },
            session_id: 'session-1',
          },
          'toolu_agent_1',
        );
        await runHooks(
          params,
          'SubagentStart',
          { agent_id: 'agent-1', agent_type: 'researcher' },
          'subagent-task-1',
        );

        await sleep(5);
        await runHooks(
          params,
          'PreToolUse',
          {
            agent_id: 'agent-1',
            tool_name: 'WebSearch',
            tool_input: { query: 'OpenTelemetry AI observability' },
            session_id: 'session-1',
          },
          'toolu_web_1',
        );
        await sleep(5);
        yield {
          type: 'assistant',
          parent_tool_use_id: 'toolu_agent_1',
          message: {
            id: 'msg_research_1',
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            usage: { input_tokens: 5, output_tokens: 2 },
            content: [
              {
                type: 'tool_use',
                id: 'toolu_web_1',
                name: 'WebSearch',
                input: { query: 'OpenTelemetry AI observability' },
              },
            ],
          },
        };

        await sleep(5);
        await runHooks(
          params,
          'PostToolUse',
          {
            agent_id: 'agent-1',
            tool_name: 'WebSearch',
            tool_response: { results: ['one'] },
          },
          'toolu_web_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          {
            tool_name: 'Agent',
            tool_response: {
              agentId: 'agent-1',
              agentType: 'researcher',
              content: [{ text: 'research done' }],
              totalDurationMs: 123,
              totalToolUseCount: 1,
            },
          },
          'toolu_agent_1',
        );

        yield {
          type: 'result',
          result: 'final answer',
          session_id: 'session-1',
          usage: { input_tokens: 20, output_tokens: 3 },
          total_cost_usd: 0.123,
        };
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);

    const tracer = trace.getTracer('test');
    const root = tracer.startSpan('root');
    await context.with(trace.setSpan(context.active(), root), async () => {
      for await (const _message of sdk.query({
        prompt: 'test prompt',
        options: { model: 'claude-opus-4-7' },
      })) {
        // Exhaust the stream.
      }
    });
    root.end();

    const spans = exporter.getFinishedSpans();
    const rootSpan = spans.find((s) => s.name === 'root')!;
    const query = spans.find((s) => s.name === 'ClaudeAgent.query')!;
    const agent = spans.find((s) => s.name === 'Agent')!;
    const subagent = spans.find((s) => s.name === 'Subagent')!;
    const webSearch = spans.find((s) => s.name === 'WebSearch')!;
    const llmSpans = spans.filter((s) => s.name === 'anthropic.messages.create');

    assert.ok(rootSpan, 'root missing');
    assert.ok(query, 'query missing');
    assert.ok(agent, 'Agent tool missing');
    assert.ok(subagent, 'Subagent missing');
    assert.ok(webSearch, 'WebSearch missing');
    assert.equal(llmSpans.length, 2);

    assert.equal(query.parentSpanId, rootSpan.spanContext().spanId);
    assert.equal(agent.parentSpanId, query.spanContext().spanId);
    assert.equal(subagent.parentSpanId, agent.spanContext().spanId);
    const opus = llmSpans.find((s) => s.attributes['llm.model_name'] === 'claude-opus-4-7')!;
    const haiku = llmSpans.find(
      (s) => s.attributes['llm.model_name'] === 'claude-haiku-4-5-20251001',
    )!;
    assert.ok(opus, 'opus LLM span missing');
    assert.ok(haiku, 'haiku LLM span missing');
    assert.equal(opus.parentSpanId, query.spanContext().spanId);
    assert.equal(haiku.parentSpanId, subagent.spanContext().spanId);
    assert.equal(webSearch.parentSpanId, subagent.spanContext().spanId);
    assert.ok(spanDurationMs(opus) > 0, 'opus LLM span should have inferred duration');
    assert.ok(spanDurationMs(haiku) > 0, 'haiku LLM span should have inferred duration');
    assert.ok(
      spanStartMs(opus) > spanStartMs(query),
      'first LLM span should start at the assistant message boundary, not query start',
    );
    assert.ok(
      spanEndMs(haiku) >= spanEndMs(webSearch) - 1,
      'tool-use LLM turn should be allowed to cover tool execution',
    );
    assert.equal(query.attributes['claude_agent_sdk.model'], 'claude-opus-4-7');
    assert.equal(query.attributes['claude_agent_sdk.total_cost_usd'], 0.123);
    assert.equal(query.attributes['llm.model_name'], undefined);
    assert.equal(query.attributes['llm.token_count.prompt'], undefined);
    assert.equal(query.attributes['llm.token_count.completion'], undefined);
    assert.equal(query.attributes['llm.cost.total'], undefined);
    assert.equal(opus.attributes['llm.token_count.prompt'], 60);
    assert.equal(opus.attributes['llm.token_count.prompt_details.cache_read'], 20);
    assert.equal(opus.attributes['llm.token_count.prompt_details.cache_creation'], 30);
    assert.equal(haiku.attributes['llm.token_count.prompt'], 5);
    assert.equal(subagent.attributes['claude_agent_sdk.agent_type'], 'researcher');
    assert.equal(subagent.attributes['claude_agent_sdk.tool_use_count'], 1);
  });

  it('groups repeated assistant chunks by message id', async () => {
    const sdk = {
      async *query(_params: QueryParams) {
        yield {
          type: 'assistant',
          message: {
            id: 'msg_same',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 10, output_tokens: 0 },
            content: [{ type: 'text', text: 'partial' }],
          },
        };
        yield {
          type: 'assistant',
          message: {
            id: 'msg_same',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: 'text', text: 'done' }],
          },
        };
        yield {
          type: 'result',
          result: 'done',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);

    for await (const _message of sdk.query({
      prompt: 'test prompt',
      options: { model: 'claude-opus-4-7' },
    })) {
      // Exhaust the stream.
    }

    const llmSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'anthropic.messages.create');

    assert.equal(llmSpans.length, 1);
    assert.equal(llmSpans[0].attributes['llm.token_count.completion'], 5);
  });

  it('keeps tools as subagent siblings when tool hooks arrive before assistant usage', async () => {
    const sdk = {
      async *query(params: QueryParams) {
        yield {
          type: 'assistant',
          message: {
            id: 'msg_main',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 10, output_tokens: 1 },
            content: [{ type: 'tool_use', id: 'toolu_agent_1', name: 'Agent', input: {} }],
          },
        };

        await runHooks(
          params,
          'PreToolUse',
          { tool_name: 'Agent', tool_input: {} },
          'toolu_agent_1',
        );
        await runHooks(
          params,
          'SubagentStart',
          { agent_id: 'agent-1', agent_type: 'researcher' },
          'toolu_agent_1',
        );
        await runHooks(
          params,
          'PreToolUse',
          {
            agent_id: 'agent-1',
            tool_name: 'WebSearch',
            tool_input: { query: 'OpenTelemetry' },
          },
          'toolu_web_1',
        );

        yield {
          type: 'assistant',
          parent_tool_use_id: 'toolu_agent_1',
          message: {
            id: 'msg_subagent',
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            usage: { input_tokens: 20, output_tokens: 2 },
            content: [
              {
                type: 'tool_use',
                id: 'toolu_web_1',
                name: 'WebSearch',
                input: { query: 'OpenTelemetry' },
              },
            ],
          },
        };

        await runHooks(
          params,
          'PostToolUse',
          {
            agent_id: 'agent-1',
            tool_name: 'WebSearch',
            tool_response: { results: [] },
          },
          'toolu_web_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          { tool_name: 'Agent', tool_response: {} },
          'toolu_agent_1',
        );
        yield { type: 'result', result: 'done', usage: { input_tokens: 30, output_tokens: 3 } };
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);
    await exhaustQuery(sdk);

    const spans = exporter.getFinishedSpans();
    const subagent = spans.find((s) => s.name === 'Subagent')!;
    const webSearch = spans.find((s) => s.name === 'WebSearch')!;
    const haiku = spans.find(
      (s) =>
        s.name === 'anthropic.messages.create' &&
        s.attributes['llm.model_name'] === 'claude-haiku-4-5-20251001',
    )!;

    assert.ok(subagent, 'Subagent missing');
    assert.ok(webSearch, 'WebSearch missing');
    assert.ok(haiku, 'Haiku LLM span missing');
    assert.equal(webSearch.parentSpanId, subagent.spanContext().spanId);
    assert.equal(haiku.parentSpanId, subagent.spanContext().spanId);
  });

  it('parents non-delegation tools under the active LLM when assistant usage arrives first', async () => {
    const sdk = {
      async *query(params: QueryParams) {
        yield {
          type: 'assistant',
          message: {
            id: 'msg_main',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 10, output_tokens: 1 },
            content: [{ type: 'tool_use', id: 'toolu_agent_1', name: 'Agent', input: {} }],
          },
        };

        await runHooks(
          params,
          'PreToolUse',
          { tool_name: 'Agent', tool_input: {} },
          'toolu_agent_1',
        );
        await runHooks(
          params,
          'SubagentStart',
          { agent_id: 'agent-1', agent_type: 'researcher' },
          'toolu_agent_1',
        );

        yield {
          type: 'assistant',
          parent_tool_use_id: 'toolu_agent_1',
          message: {
            id: 'msg_subagent',
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            usage: { input_tokens: 20, output_tokens: 2 },
            content: [
              {
                type: 'tool_use',
                id: 'toolu_web_1',
                name: 'WebSearch',
                input: { query: 'OpenTelemetry' },
              },
            ],
          },
        };

        await runHooks(
          params,
          'PreToolUse',
          {
            agent_id: 'agent-1',
            tool_name: 'WebSearch',
            tool_input: { query: 'OpenTelemetry' },
          },
          'toolu_web_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          {
            agent_id: 'agent-1',
            tool_name: 'WebSearch',
            tool_response: { results: [] },
          },
          'toolu_web_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          { tool_name: 'Agent', tool_response: {} },
          'toolu_agent_1',
        );
        yield { type: 'result', result: 'done', usage: { input_tokens: 30, output_tokens: 3 } };
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);
    await exhaustQuery(sdk);

    const spans = exporter.getFinishedSpans();
    const webSearch = spans.find((s) => s.name === 'WebSearch')!;
    const haiku = spans.find(
      (s) =>
        s.name === 'anthropic.messages.create' &&
        s.attributes['llm.model_name'] === 'claude-haiku-4-5-20251001',
    )!;

    assert.ok(webSearch, 'WebSearch missing');
    assert.ok(haiku, 'Haiku LLM span missing');
    assert.equal(webSearch.parentSpanId, haiku.spanContext().spanId);
  });

  it('does not parent later tools under an already-ended LLM span', async () => {
    const sdk = {
      async *query(params: QueryParams) {
        yield {
          type: 'assistant',
          message: {
            id: 'msg_main',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 10, output_tokens: 1 },
            content: [{ type: 'tool_use', id: 'toolu_agent_1', name: 'Agent', input: {} }],
          },
        };

        await runHooks(
          params,
          'PreToolUse',
          { tool_name: 'Agent', tool_input: {} },
          'toolu_agent_1',
        );
        await runHooks(
          params,
          'SubagentStart',
          { agent_id: 'agent-1', agent_type: 'researcher' },
          'toolu_agent_1',
        );

        yield {
          type: 'assistant',
          parent_tool_use_id: 'toolu_agent_1',
          message: {
            id: 'msg_subagent',
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            usage: { input_tokens: 20, output_tokens: 2 },
            content: [
              {
                type: 'tool_use',
                id: 'toolu_web_1',
                name: 'WebSearch',
                input: { query: 'OpenTelemetry' },
              },
            ],
          },
        };

        yield {
          type: 'assistant',
          message: {
            id: 'msg_root_2',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 30, output_tokens: 3 },
            content: [{ type: 'text', text: 'continue' }],
          },
        };

        await runHooks(
          params,
          'PreToolUse',
          {
            agent_id: 'agent-1',
            tool_name: 'WebSearch',
            tool_input: { query: 'OpenTelemetry' },
          },
          'toolu_web_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          {
            agent_id: 'agent-1',
            tool_name: 'WebSearch',
            tool_response: { results: [] },
          },
          'toolu_web_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          { tool_name: 'Agent', tool_response: {} },
          'toolu_agent_1',
        );
        yield { type: 'result', result: 'done', usage: { input_tokens: 60, output_tokens: 6 } };
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);
    await exhaustQuery(sdk);

    const spans = exporter.getFinishedSpans();
    const subagent = spans.find((s) => s.name === 'Subagent')!;
    const webSearch = spans.find((s) => s.name === 'WebSearch')!;
    const haiku = spans.find(
      (s) =>
        s.name === 'anthropic.messages.create' &&
        s.attributes['llm.model_name'] === 'claude-haiku-4-5-20251001',
    )!;

    assert.ok(subagent, 'Subagent missing');
    assert.ok(webSearch, 'WebSearch missing');
    assert.ok(haiku, 'Haiku LLM span missing');
    assert.equal(webSearch.parentSpanId, subagent.spanContext().spanId);
    assert.notEqual(webSearch.parentSpanId, haiku.spanContext().spanId);
  });

  it('keeps Agent and Bash as task siblings even when an LLM span is active', async () => {
    const sdk = {
      async *query(params: QueryParams) {
        yield {
          type: 'assistant',
          message: {
            id: 'msg_main',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 10, output_tokens: 1 },
            content: [
              { type: 'tool_use', id: 'toolu_agent_1', name: 'Agent', input: {} },
              { type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'true' } },
            ],
          },
        };

        await runHooks(
          params,
          'PreToolUse',
          { tool_name: 'Agent', tool_input: {} },
          'toolu_agent_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          { tool_name: 'Agent', tool_response: {} },
          'toolu_agent_1',
        );
        await runHooks(
          params,
          'PreToolUse',
          { tool_name: 'Bash', tool_input: { command: 'true' } },
          'toolu_bash_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          { tool_name: 'Bash', tool_response: { stdout: '' } },
          'toolu_bash_1',
        );
        yield { type: 'result', result: 'done', usage: { input_tokens: 10, output_tokens: 1 } };
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);
    await exhaustQuery(sdk);

    const spans = exporter.getFinishedSpans();
    const query = spans.find((s) => s.name === 'ClaudeAgent.query')!;
    const agent = spans.find((s) => s.name === 'Agent')!;
    const bash = spans.find((s) => s.name === 'Bash')!;
    const llm = spans.find((s) => s.name === 'anthropic.messages.create')!;

    assert.ok(query, 'query missing');
    assert.ok(agent, 'Agent missing');
    assert.ok(bash, 'Bash missing');
    assert.ok(llm, 'LLM missing');
    assert.equal(agent.parentSpanId, query.spanContext().spanId);
    assert.equal(bash.parentSpanId, query.spanContext().spanId);
    assert.notEqual(agent.parentSpanId, llm.spanContext().spanId);
    assert.notEqual(bash.parentSpanId, llm.spanContext().spanId);
  });

  it('ends the query span when the wrapped query throws during iterator construction', async () => {
    const sdk = {
      query(_params: QueryParams): AsyncIterable<unknown> {
        throw new Error('construction failed');
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);

    await assert.rejects(() => exhaustQuery(sdk), /construction failed/);

    const query = exporter.getFinishedSpans().find((s) => s.name === 'ClaudeAgent.query')!;
    assert.ok(query, 'query missing');
    assert.equal(query.status.code, 2);
  });

  it('cleans up the query span only once when an iterator is returned multiple times', async () => {
    const sdk = {
      async *query(_params: QueryParams) {
        yield {
          type: 'assistant',
          message: {
            id: 'msg_one',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 10, output_tokens: 1 },
            content: [{ type: 'text', text: 'partial' }],
          },
        };
        await sleep(50);
        yield { type: 'result', result: 'done', usage: { input_tokens: 10, output_tokens: 1 } };
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);

    const iterator = sdk
      .query({ prompt: 'test prompt', options: { model: 'claude-opus-4-7' } })
      [Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await iterator.return?.();

    const querySpans = exporter.getFinishedSpans().filter((s) => s.name === 'ClaudeAgent.query');
    assert.equal(querySpans.length, 1);
    assert.equal(querySpans[0].status.code, 1);
  });

  it('uses final result usage to correct the last pending assistant group', async () => {
    const sdk = {
      async *query(params: QueryParams) {
        yield {
          type: 'assistant',
          message: {
            id: 'msg_tool',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 100, output_tokens: 10 },
            content: [{ type: 'tool_use', id: 'toolu_agent_1', name: 'Agent', input: {} }],
          },
        };
        await runHooks(
          params,
          'PreToolUse',
          { tool_name: 'Agent', tool_input: {} },
          'toolu_agent_1',
        );
        await runHooks(
          params,
          'PostToolUse',
          { tool_name: 'Agent', tool_response: {} },
          'toolu_agent_1',
        );
        yield {
          type: 'assistant',
          message: {
            id: 'msg_final',
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 200, output_tokens: 1 },
            content: [{ type: 'text', text: 'final answer' }],
          },
        };
        yield {
          type: 'result',
          result: 'final answer',
          usage: {
            input_tokens: 300,
            output_tokens: 110,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 30,
          },
        };
      },
    };

    wireClaudeAgentSDKInstrumentation(sdk);

    for await (const _message of sdk.query({
      prompt: 'test prompt',
      options: { model: 'claude-opus-4-7' },
    })) {
      // Exhaust the stream.
    }

    const llmSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'anthropic.messages.create');

    assert.equal(llmSpans.length, 2);
    assert.equal(llmSpans[0].attributes['llm.token_count.completion'], 10);
    assert.equal(llmSpans[1].attributes['llm.token_count.completion'], 100);
    assert.equal(llmSpans[1].attributes['llm.token_count.prompt_details.cache_read'], 20);
    assert.equal(llmSpans[1].attributes['llm.token_count.prompt_details.cache_creation'], 30);
  });
});
