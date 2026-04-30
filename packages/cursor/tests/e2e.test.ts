import { describe, it, expect, beforeEach } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapAgent } from '../src/index.js';
import { ATTR, EVENT, SPAN } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

interface CapturedEvent {
  source: 'stream' | 'onDelta' | 'onStep' | 'onDidChangeStatus';
  ts_ms: number;
  ordinal: number;
  payload: any;
}

function loadFixture(name: string): CapturedEvent[] {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${name}.json`), 'utf8'));
}

function isArtifact(p: any): boolean {
  if (!p || typeof p !== 'object') return false;
  return Boolean(
    p.__caught_error || p.__stream_error || p.__top_level_error || p.__injected || p.__cancel_error,
  );
}

function unwrapStream(payload: any): any {
  return payload?.event ?? payload;
}
function unwrapDelta(payload: any): any {
  return payload?.update ?? payload;
}
function unwrapStatus(payload: any): string | undefined {
  if (typeof payload === 'string') return payload;
  return payload?.status;
}

interface MockAgent {
  id: string;
  model: { id: string };
  send(prompt: unknown, options?: any): Promise<MockRun>;
}

interface MockRun {
  id: string;
  agentId: string;
  stream(): AsyncGenerator<unknown, void>;
  onDidChangeStatus(listener: (status: string) => void): () => void;
  wait(): Promise<{ id: string; status: string }>;
}

function makeMockAgent(fixtureName: string): MockAgent {
  const events = loadFixture(fixtureName);
  const streamEvents = events
    .filter((e) => e.source === 'stream')
    .map((e) => unwrapStream(e.payload))
    .filter((p) => !isArtifact(p));
  const deltaUpdates = events
    .filter((e) => e.source === 'onDelta')
    .map((e) => unwrapDelta(e.payload))
    .filter((p) => !isArtifact(p));
  const statusChanges = events
    .filter((e) => e.source === 'onDidChangeStatus')
    .map((e) => unwrapStatus(e.payload))
    .filter((s): s is string => typeof s === 'string');

  return {
    id: 'mock-agent',
    model: { id: 'composer-2' },
    async send(_prompt: unknown, options: any = {}): Promise<MockRun> {
      const onDelta = options?.onDelta;
      const statusListeners: ((status: string) => void)[] = [];

      const run: MockRun = {
        id: 'mock-run',
        agentId: 'mock-agent',
        async *stream(): AsyncGenerator<unknown, void> {
          for (const event of streamEvents) {
            yield event;
          }
        },
        onDidChangeStatus(listener: (s: string) => void): () => void {
          statusListeners.push(listener);
          return () => {};
        },
        async wait() {
          return { id: 'mock-run', status: 'finished' };
        },
      };

      setTimeout(() => {
        for (const update of deltaUpdates) {
          try {
            onDelta?.({ update });
          } catch {
            /* swallow */
          }
        }
        for (const status of statusChanges) {
          for (const listener of statusListeners) {
            try {
              listener(status);
            } catch {
              /* swallow */
            }
          }
        }
      }, 0);

      return run;
    },
  };
}

let provider: BasicTracerProvider;
let exporter: InMemorySpanExporter;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
});

async function flushAll(): Promise<ReadableSpan[]> {
  await new Promise((r) => setTimeout(r, 200));
  await provider.forceFlush();
  return exporter.getFinishedSpans();
}

describe('e2e: wrapAgent + cookbook quickstart shape (local-quickstart fixture)', () => {
  it('produces a cursor.run root span with usage attrs and terminal_status=finished', async () => {
    const mock = makeMockAgent('local-quickstart');
    const agent = wrapAgent(mock, {
      sessionId: 'test-session',
      userId: 'test-user',
      tracer: provider.getTracer('test'),
    });

    const run = (await agent.send('Explain this project')) as any;
    for await (const _e of run.stream()) {
      /* drain user iterator */
    }
    const spans = await flushAll();

    const runSpan = spans.find((s) => s.name === SPAN.RUN);
    expect(runSpan, 'cursor.run span not found').toBeDefined();
    const a = runSpan!.attributes;
    expect(typeof a[ATTR.AGENT_ID]).toBe('string');
    expect((a[ATTR.AGENT_ID] as string).length).toBeGreaterThan(0);
    expect(a[ATTR.MODEL_ID]).toBe('composer-2');
    expect(a[ATTR.RUNTIME]).toBe('local');
    expect(a[ATTR.SESSION_ID]).toBe('test-session');
    expect(a[ATTR.USER_ID]).toBe('test-user');
    expect(a[ATTR.TERMINAL_STATUS]).toBe('finished');
    expect(typeof a[ATTR.USAGE_INPUT]).toBe('number');
    expect(typeof a[ATTR.USAGE_OUTPUT]).toBe('number');
  });

  it('emits child cursor.tool.* spans with parentSpanId pointing at the run span', async () => {
    const mock = makeMockAgent('local-quickstart');
    const agent = wrapAgent(mock, {
      sessionId: 's',
      userId: 'u',
      tracer: provider.getTracer('test'),
    });

    const run = (await agent.send('Explain')) as any;
    for await (const _e of run.stream()) {
      /* drain */
    }
    const spans = await flushAll();

    const runSpan = spans.find((s) => s.name === SPAN.RUN);
    const toolSpans = spans.filter((s) => s.name.startsWith(SPAN.TOOL_PREFIX));
    expect(toolSpans.length).toBeGreaterThan(0);
    expect(runSpan).toBeDefined();
    const runId = runSpan!.spanContext().spanId;
    for (const tool of toolSpans) {
      expect(tool.parentSpanId).toBe(runId);
      expect(typeof tool.attributes[ATTR.TOOL_CALL_ID]).toBe('string');
      expect(typeof tool.attributes[ATTR.TOOL_TYPE]).toBe('string');
    }
  });

  it('emits assistant.text span events on the run span', async () => {
    const mock = makeMockAgent('local-quickstart');
    const agent = wrapAgent(mock, { tracer: provider.getTracer('test') });

    const run = (await agent.send('Explain')) as any;
    for await (const _e of run.stream()) {
      /* drain */
    }
    const spans = await flushAll();

    const runSpan = spans.find((s) => s.name === SPAN.RUN);
    const textEvents = runSpan!.events.filter((ev) => ev.name === EVENT.ASSISTANT_TEXT);
    expect(textEvents.length).toBeGreaterThan(0);
  });
});

describe('e2e: cancelled flow (local-cancelled fixture)', () => {
  it('closes run span with terminal_status=cancelled and dangling tool span gets terminated_by_cancel=true', async () => {
    const mock = makeMockAgent('local-cancelled');
    const agent = wrapAgent(mock, { tracer: provider.getTracer('test') });

    const run = (await agent.send('...')) as any;
    for await (const _e of run.stream()) {
      /* drain */
    }
    const spans = await flushAll();

    const runSpan = spans.find((s) => s.name === SPAN.RUN);
    expect(runSpan!.attributes[ATTR.TERMINAL_STATUS]).toBe('cancelled');

    const toolSpans = spans.filter((s) => s.name.startsWith(SPAN.TOOL_PREFIX));
    const terminatedByCancel = toolSpans.find(
      (t) => t.attributes[ATTR.TOOL_TERMINATED_BY_CANCEL] === true,
    );
    expect(terminatedByCancel).toBeDefined();
  });
});
