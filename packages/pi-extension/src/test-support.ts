// Shared test harness for the handler unit tests. Not shipped (excluded from package
// `files`). A tracer whose spans record every attribute / event / status so tests can
// assert on exported values, plus fake pi runtimes for the event and command handlers.
import { ROOT_CONTEXT, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { createSpanState } from './state.ts';
import type { Runtime } from './runtime.ts';

export interface SpanRecord {
  name: string;
  attrs: Record<string, unknown>;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  status?: { code: SpanStatusCode; message?: string };
  ended: boolean;
}

export function recordingTracer(): { tracer: Tracer; spans: SpanRecord[] } {
  const spans: SpanRecord[] = [];
  const tracer = {
    startSpan(name: string) {
      const rec: SpanRecord = { name, attrs: {}, events: [], ended: false };
      const span = {
        setAttribute(key: string, value: unknown) {
          rec.attrs[key] = value;
          return span;
        },
        setAttributes(obj: Record<string, unknown>) {
          Object.assign(rec.attrs, obj);
          return span;
        },
        addEvent(eventName: string, attrs?: Record<string, unknown>) {
          rec.events.push({ name: eventName, attrs: attrs ?? {} });
          return span;
        },
        setStatus(status: { code: SpanStatusCode; message?: string }) {
          rec.status = status;
          return span;
        },
        end() {
          rec.ended = true;
        },
        spanContext: () => ({ traceId: 't'.repeat(32), spanId: 's'.repeat(16), traceFlags: 1 }),
        isRecording: () => true,
        updateName() {
          return span;
        },
        recordException() {},
      } as unknown as Span;
      spans.push(rec);
      return span;
    },
  } as unknown as Tracer;
  return { tracer, spans };
}

// A fake pi runtime for event-handler tests. Records provider flush/shutdown calls and
// defaults to an open session context (in pi, agent_start opens the session span before
// any turn_start; tests that exercise the no-context edge null it explicitly).
export function fakeRuntime(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const { tracer, spans } = recordingTracer();
  const providerCalls = { flush: 0, shutdown: 0 };
  const rt = {
    pi: {
      on: (event: string, handler: (raw: unknown, ctx?: unknown) => unknown) =>
        handlers.set(event, handler),
    },
    state: createSpanState(),
    config: {
      captureFullPayload: false,
      captureToolIo: true,
      stateDir: '/tmp/pi-review-test',
      ...config,
    },
    envProvided: {},
    configIssues: [],
    provider: {
      forceFlush: async () => {
        providerCalls.flush += 1;
      },
      shutdown: async () => {
        providerCalls.shutdown += 1;
      },
    },
    tracer,
    debug: () => {},
  } as unknown as Runtime;
  rt.state.sessionCtx = ROOT_CONTEXT;
  return { rt, handlers, spans, providerCalls };
}

// A context with no-op UI hooks, for handlers that call setStatus / setWidget / notify.
export const UI_CTX = {
  ui: { setStatus() {}, setWidget() {}, notify() {} },
  mode: 'tui',
  hasUI: true,
  cwd: '/tmp',
};

export const MODEL_CTX = { model: { provider: 'openai', id: 'gpt-4o' } };

export async function fire(
  handlers: Map<string, (raw: unknown, ctx?: unknown) => unknown>,
  name: string,
  raw: unknown,
  ctx?: unknown,
): Promise<void> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`handler ${name} not registered`);
  await handler(raw, ctx);
}

export function firstSpan(spans: SpanRecord[]): SpanRecord {
  const span = spans.at(0);
  if (!span) throw new Error('expected at least one recorded span');
  return span;
}

// A fake pi runtime for the /traceroot command handler: captures the registered command
// handler and the notifications it emits, and records provider flush/shutdown calls.
export function commandRuntime(stateOverrides: Record<string, unknown> = {}) {
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notifications: Array<{ message: string; level?: string }> = [];
  const providerCalls = { flush: 0, shutdown: 0 };
  const rt = {
    pi: {
      on: () => {},
      registerCommand: (
        _name: string,
        opts: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        commandHandler = opts.handler;
      },
    },
    state: createSpanState(),
    config: {
      project: 'pi',
      otlpEndpoint: 'http://localhost:8000',
      enabled: true,
      uiUrl: 'http://localhost:3000',
    },
    provider: {
      forceFlush: async () => {
        providerCalls.flush += 1;
      },
      shutdown: async () => {
        providerCalls.shutdown += 1;
      },
    },
    debug: () => {},
  } as unknown as Runtime;
  Object.assign(rt.state, stateOverrides);
  const ctx = {
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus() {},
      setWidget() {},
    },
    mode: 'tui',
  };
  const run = async (args: string) => {
    if (!commandHandler) throw new Error('command handler not registered');
    await commandHandler(args, ctx);
  };
  return { rt, run, notifications, providerCalls, registered: () => commandHandler !== undefined };
}
