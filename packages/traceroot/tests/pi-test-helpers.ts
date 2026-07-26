// Shared fixtures for packages/traceroot/tests/pi-*.test.ts.
// CONTRACT: prompt()'s promise stays pending until a non-retry agent_end; never await it before emitting, and always await it before asserting the root.
import { trace } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  instrumentPiCodingAgent,
  type AgentEvent,
  type AssistantMessage,
  type PiInstrumentationConfig,
  type PromptOptions,
} from '../src/pi';

export class CapturingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }
  async shutdown(): Promise<void> {}
}

// Fresh class per rig/test; instrumentPiCodingAgent patches the prototype directly.
export function makeFakeSessionClass(shouldReject?: (text: string) => boolean) {
  return class FakeAgentSession {
    sessionId = 'sess-1';
    disposed = false;
    isStreaming = false;
    private listeners: Array<(event: AgentEvent) => void> = [];
    private pending: { resolve: () => void; reject: (err: unknown) => void } | undefined;

    async prompt(text: string, options?: PromptOptions): Promise<void> {
      if (shouldReject?.(text)) {
        throw new Error(`validation failed for: ${text}`);
      }
      // Queues into the active run; must not touch this.pending (the earlier call's).
      if (this.isStreaming && options?.streamingBehavior) {
        return;
      }
      return new Promise<void>((resolve, reject) => {
        this.pending = { resolve, reject };
      });
    }
    subscribe(listener: (event: AgentEvent) => void): () => void {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }
    emit(event: AgentEvent): void {
      for (const listener of this.listeners) listener(event);
      if (event.type === 'agent_end' && !event.willRetry && this.pending) {
        const { resolve } = this.pending;
        this.pending = undefined;
        resolve();
      }
    }
    // Settles as SUCCESS with no agent_end (mirrors a handled "/command").
    resolvePrompt(): void {
      if (!this.pending) return;
      const { resolve } = this.pending;
      this.pending = undefined;
      resolve();
    }
    rejectPrompt(err: unknown): void {
      if (!this.pending) return;
      const { reject } = this.pending;
      this.pending = undefined;
      reject(err);
    }
    dispose(): void {
      this.disposed = true;
      this.listeners = [];
    }
  };
}

// trace.disable() must run first, or a stale registration leaks spans across rigs.
export function makeRig(config: PiInstrumentationConfig = {}): {
  capture: CapturingExporter;
  Session: ReturnType<typeof makeFakeSessionClass>;
} {
  trace.disable();
  const capture = new CapturingExporter();
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(capture));
  provider.register();
  const Session = makeFakeSessionClass();
  const sdk = { AgentSession: Session };
  instrumentPiCodingAgent(sdk, config);
  return { capture, Session };
}

// Placeholder usage/cost; tests needing exact figures should pass an explicit override.
export function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

export function attrs(span: ReadableSpan): Record<string, unknown> {
  return span.attributes as Record<string, unknown>;
}
