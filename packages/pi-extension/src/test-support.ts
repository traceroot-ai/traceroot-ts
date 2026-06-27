// Shared test harness for the handler unit tests. Not shipped (excluded from package
// `files`). A tracer whose spans record every attribute / event / status so tests can
// assert on exported values, plus fake pi runtimes for the event and command handlers.
import { ROOT_CONTEXT, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpanState, type SpanState } from './state.ts';
import type { TracerootPiConfig } from './config.ts';
import type { Runtime } from './runtime.ts';

// A fake OTLP provider that counts the flush/shutdown calls the lifecycle handlers make.
function fakeProvider(): {
  provider: { forceFlush: () => Promise<void>; shutdown: () => Promise<void> };
  providerCalls: { flush: number; shutdown: number };
} {
  const providerCalls = { flush: 0, shutdown: 0 };
  const provider = {
    forceFlush: async () => {
      providerCalls.flush += 1;
    },
    shutdown: async () => {
      providerCalls.shutdown += 1;
    },
  };
  return { provider, providerCalls };
}

// Run `fn` against a throwaway temp directory, always cleaning it up afterwards.
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tr-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Initialize a git repo in `dir`, optionally with an origin remote.
export function initGitRepo(dir: string, remoteUrl?: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (remoteUrl) execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
}

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
// defaults sessionCtx to a non-null (ROOT) context, mirroring a real session after
// agent_start opens the session span (tests that exercise the no-context edge null it).
export function fakeRuntime(config: Partial<TracerootPiConfig> = {}) {
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const { tracer, spans } = recordingTracer();
  const { provider, providerCalls } = fakeProvider();
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
    provider,
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
export function commandRuntime(stateOverrides: Partial<SpanState> = {}) {
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notifications: Array<{ message: string; level?: string }> = [];
  const { provider, providerCalls } = fakeProvider();
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
    provider,
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
