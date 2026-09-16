// Coverage for src/pi-agent-core.ts: instrumentPiAgentCore() patches
// @earendil-works/pi-agent-core's `Agent.prototype.prompt`/`subscribe`, reusing
// pi.ts's span builders (root/LLM/tool) so pi-agent-core traces render identically
// to pi-coding-agent ones. Style mirrors tests/pi.test.ts and
// tests/pi-lifecycle-edge-cases.test.ts (node:test + node:assert/strict).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { instrumentPiAgentCore } from '../src/pi-agent-core';

type Listener = (e: unknown) => void;

function attrsOf(span: ReadableSpan): Record<string, unknown> {
  return span.attributes as Record<string, unknown>;
}

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

  it("agentSpan 'unless-nested': under an active span the run's spans hang off the host, no Agent.prompt", async () => {
    const Agent = makeFakeAgentClass();
    instrumentPiAgentCore({ Agent }, { agentSpan: 'unless-nested' });
    const tracer = trace.getTracer('test');
    await tracer.startActiveSpan('host', async (host) => {
      await new Agent().prompt('hi');
      host.end();
    });
    const spans = exporter.getFinishedSpans();
    assert.deepEqual(spans.map((s) => s.name).sort(), ['host', 'bash: ls', 'm1', 'm1'].sort());
    const host = spans.find((s) => s.name === 'host')!;
    for (const llm of spans.filter((s) => s.name === 'm1')) {
      assert.equal(llm.parentSpanId, host.spanContext().spanId);
    }
    // The host's span is left as the host set it: no status, no output stamped.
    assert.equal(host.status.code, 0 /* UNSET */);
    assert.equal(attrsOf(host)['output.value'], undefined);
  });

  it("agentSpan 'unless-nested' still opens Agent.prompt as the root when nothing is active", async () => {
    const Agent = makeFakeAgentClass();
    instrumentPiAgentCore({ Agent }, { agentSpan: 'unless-nested' });
    await new Agent().prompt('hi');
    const root = exporter.getFinishedSpans().find((s) => s.name === 'Agent.prompt')!;
    assert.ok(root);
    assert.equal(root.parentSpanId, undefined);
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

  it('a captureContent function decides what lands on the root and LLM spans, input included', async () => {
    const Base = makeFakeAgentClass();
    // The real Agent exposes its conversation as `state.messages`; the fake keeps a
    // fixed one so llm_input has something to read.
    class Agent extends Base {
      state = {
        systemPrompt: 'be brief',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'toolResult', toolCallId: 'tc0', toolName: 'bash', content: [], isError: false },
        ],
      };
    }
    const seen: string[] = [];
    instrumentPiAgentCore(
      { Agent },
      {
        captureContent: (kind, value) => {
          seen.push(kind);
          switch (kind) {
            case 'agent_input':
              return `in:${value.text}`;
            case 'agent_output':
              return `out:${value.messages?.length ?? 0}`;
            case 'llm_input':
              return `ctx:${value.systemPrompt}:${value.messages?.map((m) => m.role).join(',')}`;
            case 'llm_output':
              return `reply:${(value.message as { stopReason?: string } | undefined)?.stopReason}`;
          }
        },
      },
    );
    await new Agent().prompt('hi');
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'Agent.prompt')!;
    const llm = spans.filter((s) => s.name === 'm1');
    assert.equal(attrsOf(root)['input.value'], 'in:hi');
    assert.equal(attrsOf(root)['output.value'], 'out:1');
    assert.equal(llm.length, 2);
    assert.equal(attrsOf(llm[0]!)['input.value'], 'ctx:be brief:user,toolResult');
    assert.equal(attrsOf(llm[0]!)['output.value'], 'reply:toolUse');
    assert.equal(attrsOf(llm[1]!)['output.value'], 'reply:stop');
    assert.deepEqual(seen.filter((k) => k === 'llm_input').length, 2, 'asked once per model call');
  });

  it('a captureContent function returning undefined records nothing, and true never records llm_input', async () => {
    const Silent = makeFakeAgentClass();
    instrumentPiAgentCore({ Agent: Silent }, { captureContent: () => undefined });
    await new Silent().prompt('hi');
    // Tool spans are governed by captureToolIo, not captureContent, so they keep their I/O.
    for (const span of exporter.getFinishedSpans().filter((s) => !s.name.startsWith('bash'))) {
      assert.equal(attrsOf(span)['input.value'], undefined, `${span.name} input`);
      assert.equal(attrsOf(span)['output.value'], undefined, `${span.name} output`);
    }
    exporter.reset();

    const Base = makeFakeAgentClass();
    class Agent extends Base {
      state = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] };
    }
    instrumentPiAgentCore({ Agent }, { captureContent: true });
    await new Agent().prompt('hi');
    const spans = exporter.getFinishedSpans();
    assert.equal(attrsOf(spans.find((s) => s.name === 'Agent.prompt')!)['input.value'], 'hi');
    const llm = spans.find((s) => s.name === 'm1')!;
    assert.equal(
      attrsOf(llm)['input.value'],
      undefined,
      'boolean true keeps model inputs off the span',
    );
    assert.ok(attrsOf(llm)['output.value'], 'boolean true still records the assistant output');
  });

  it('a throwing captureContent does not abort the run', async () => {
    const Agent = makeFakeAgentClass();
    instrumentPiAgentCore(
      { Agent },
      {
        captureContent: () => {
          throw new Error('boom');
        },
      },
    );
    await new Agent().prompt('hi');
    const root = exporter.getFinishedSpans().find((s) => s.name === 'Agent.prompt')!;
    assert.equal(root.status.code, SpanStatusCode.OK);
  });

  it('a result capture that throws still closes the tool span, with no output recorded', async () => {
    const Agent = makeFakeAgentClass();
    let seen = '';
    instrumentPiAgentCore(
      { Agent },
      {
        // Start capture (args, result undefined) succeeds; only the end capture throws.
        captureToolIo: (_toolName, args, result) => {
          if (result !== undefined) throw new Error('result policy exploded');
          return { args };
        },
        onToolSpan: ({ spanId }) => {
          seen = spanId;
        },
      },
    );
    await new Agent().prompt('hi');
    const spans = exporter.getFinishedSpans();
    const tool = spans.find((s) => s.name.startsWith('bash'));
    assert.ok(tool, 'the tool span reached the exporter');
    assert.equal(tool!.spanContext().spanId, seen, 'it is the span the host was told about');
    assert.equal(attrsOf(tool!)['output.value'], undefined, 'no output was recorded');
    assert.equal(spans.filter((s) => s.name === 'Agent.prompt').length, 1);
  });

  it('a throwing captureToolIo does not abort the run', async () => {
    const Agent = makeFakeAgentClass();
    instrumentPiAgentCore(
      { Agent },
      {
        captureToolIo: () => {
          throw new Error('policy exploded');
        },
      },
    );
    // The fake agent's dispatcher calls subscribers synchronously: an uncaught
    // throw here would have escaped prompt() and rejected the run.
    await new Agent().prompt('hi');
    const root = exporter.getFinishedSpans().find((s) => s.name === 'Agent.prompt')!;
    assert.equal(root.status.code, SpanStatusCode.OK);
  });

  it('an overlapping prompt() on the same Agent supersedes the first run', async () => {
    // A fake whose prompt() parks until released, so two runs can overlap.
    class ParkedAgent {
      listeners: Listener[] = [];
      release: (() => void)[] = [];
      subscribe(l: Listener): () => void {
        this.listeners.push(l);
        return () => {
          this.listeners = this.listeners.filter((x) => x !== l);
        };
      }
      prompt(_text: string): Promise<void> {
        const emit = (e: unknown): void => this.listeners.forEach((l) => l(e));
        emit({
          type: 'message_start',
          message: { role: 'assistant', model: 'm1', provider: 'p1' },
        });
        return new Promise<void>((resolve) => {
          this.release.push(() => {
            emit({ type: 'agent_end', messages: [] });
            resolve();
          });
        });
      }
    }
    instrumentPiAgentCore({ Agent: ParkedAgent });
    const agent = new ParkedAgent();
    const first = agent.prompt('one');
    const second = agent.prompt('two');
    // The first run was closed out the moment the second started …
    const roots = () => exporter.getFinishedSpans().filter((s) => s.name === 'Agent.prompt');
    assert.equal(roots().length, 1);
    assert.equal(roots()[0].status.code, SpanStatusCode.ERROR);
    assert.match(String(roots()[0].status.message), /superseded/);
    // … and its late settle must not clear the second run's state: the second
    // run still finalizes its own root normally.
    agent.release[0]();
    await first;
    agent.release[1]();
    await second;
    assert.equal(roots().length, 2);
    // The superseded root keeps its ERROR/superseded status after its own late
    // settle — that settle must not re-finalize it as OK.
    assert.equal(roots()[0].status.code, SpanStatusCode.ERROR);
    assert.match(String(roots()[0].status.message), /superseded/);
    assert.equal(roots()[1].status.code, SpanStatusCode.OK);
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
