// Coverage for src/pi-agent-core.ts: instrumentPiAgentCore() patches
// @earendil-works/pi-agent-core's `Agent.prototype.prompt`/`subscribe`, reusing
// pi.ts's span builders (root/LLM/tool) so pi-agent-core traces render identically
// to pi-coding-agent ones. Style mirrors tests/pi.test.ts and
// tests/pi-lifecycle-edge-cases.test.ts (node:test + node:assert/strict).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { context, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { instrumentPiAgentCore } from '../src/pi-agent-core';

type Listener = (e: unknown) => void;

// Fresh class per call — instrumentPiAgentCore() patches Agent.prototype directly,
// and WRAPPED is a chain-traversing read (matches pi.ts's own WRAPPED check), so a
// subclass of an already-wrapped class would inherit WRAPPED=true and no-op instead
// of installing its own config. Mirrors pi-test-helpers.ts's makeFakeSessionClass.
function makeFakeAgentClass() {
  return class FakeAgent {
    listeners: Listener[] = [];
    subscribe(l: Listener): () => void {
      this.listeners.push(l);
      return () => {
        this.listeners = this.listeners.filter((x) => x !== l);
      };
    }
    async prompt(_text: string): Promise<void> {
      const emit = (e: unknown): void => this.listeners.forEach((l) => l(e));
      emit({ type: 'agent_start' });
      emit({ type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'p1' } });
      emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'm1',
          provider: 'p1',
          usage: {
            input: 5,
            output: 7,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { total: 0.001 },
          },
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
        },
      });
      emit({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'ls' },
      });
      emit({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'bash',
        result: 'a\nb',
        isError: false,
      });
      emit({ type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'p1' } });
      emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'm1',
          provider: 'p1',
          usage: {
            input: 9,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { total: 0.001 },
          },
          stopReason: 'stop',
          content: [{ type: 'text', text: 'done' }],
        },
      });
      emit({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
      });
    }
  };
}

// Shared by tests 1-3 (span shape, parenting, idempotency), matching the plan's own
// fixture: those three intentionally reuse ONE class/sdk across cases (test 3's
// idempotency check depends on that sharing). Tests needing a distinct config
// (onToolSpan / captureToolIo function / throwing) use a fresh makeFakeAgentClass()
// each, below, to avoid WRAPPED being inherited from this shared FakeAgent.
const FakeAgent = makeFakeAgentClass();
const sdk = { Agent: FakeAgent };

let exporter: InMemorySpanExporter;

beforeEach(() => {
  trace.disable();
  context.disable();
  exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
});

afterEach(() => {
  trace.disable();
  context.disable();
});

describe('instrumentPiAgentCore', () => {
  it('emits root -> llm -> tool spans for one run', async () => {
    instrumentPiAgentCore(sdk);
    await new FakeAgent().prompt('hi');
    const names = exporter
      .getFinishedSpans()
      .map((s) => s.name)
      .sort();
    assert.deepEqual(names, ['Agent.prompt', 'bash: ls', 'm1', 'm1'].sort());
    const root = exporter.getFinishedSpans().find((s) => s.name === 'Agent.prompt')!;
    assert.equal(root.parentSpanId, undefined);
  });

  it('nests under an active parent span instead of opening a root', async () => {
    instrumentPiAgentCore(sdk);
    const tracer = trace.getTracer('test');
    await tracer.startActiveSpan('host', async (host) => {
      await new FakeAgent().prompt('hi');
      host.end();
    });
    const agent = exporter.getFinishedSpans().find((s) => s.name === 'Agent.prompt')!;
    const host = exporter.getFinishedSpans().find((s) => s.name === 'host')!;
    assert.equal(agent.parentSpanId, host.spanContext().spanId);
    assert.equal(agent.spanContext().traceId, host.spanContext().traceId);
  });

  it('is idempotent', () => {
    const a = instrumentPiAgentCore(sdk);
    const b = instrumentPiAgentCore(sdk);
    assert.equal(a, b);
    // wrapped once: the patched prompt is no longer the class's own bare "prompt" function
    assert.notEqual(FakeAgent.prototype.prompt.name, 'prompt');
  });

  it('fires onToolSpan with the tool span ids', async () => {
    const seen: Array<{ toolCallId: string; spanId: string; traceId: string }> = [];
    const Agent = makeFakeAgentClass();
    instrumentPiAgentCore({ Agent }, { onToolSpan: (i) => seen.push(i) });
    await new Agent().prompt('hi');
    assert.equal(seen[0]?.toolCallId, 'tc1');
    assert.match(seen[0]!.spanId, /^[0-9a-f]{16}$/);
  });

  it('applies a captureToolIo function to tool span attributes', async () => {
    const Agent = makeFakeAgentClass();
    instrumentPiAgentCore(
      { Agent },
      { captureToolIo: (_toolName, args) => ({ args, result: '[withheld]' }) },
    );
    await new Agent().prompt('hi');
    const tool = exporter.getFinishedSpans().find((s) => s.name.startsWith('bash'))!;
    assert.equal((tool.attributes as Record<string, unknown>)['output.value'], '[withheld]');
  });

  it('closes dangling spans when the run throws', async () => {
    const Base = makeFakeAgentClass();
    class Throwing extends Base {
      async prompt(_text: string): Promise<void> {
        this.listeners.forEach((l) =>
          l({ type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'p1' } }),
        );
        throw new Error('boom');
      }
    }
    instrumentPiAgentCore({ Agent: Throwing });
    await assert.rejects(() => new Throwing().prompt('x'), /boom/);
    const finished: ReadableSpan[] = exporter.getFinishedSpans();
    assert.equal(
      finished.some((s) => s.name === 'Agent.prompt' && s.status.code === 2 /* ERROR */),
      true,
    );
    assert.equal(
      finished.some((s) => s.name === 'm1'),
      true,
      'the open LLM span was swept',
    );
  });
});
