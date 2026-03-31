// src/types.ts

export type SpanType = 'span' | 'agent' | 'tool' | 'llm';

export interface ObserveOptions {
  /** Span name. Defaults to fn.name, then 'anonymous'. */
  name?: string;
  /** Span kind. Defaults to 'span' → openinference.span.kind = 'CHAIN'. */
  type?: SpanType;
  /** Input to record on the span. Explicitly passed — no auto-inference. */
  input?: unknown;
}

export interface InitializeOptions {
  /** API key for TraceRoot. Falls back to TRACEROOT_API_KEY env var. */
  apiKey?: string;
  /** Base URL for the TraceRoot backend. Defaults to https://app.traceroot.ai */
  baseUrl?: string;
  /**
   * Modules to instrument.
   * - undefined → auto-instrument all supported modules (CJS only, RITM hooks)
   * - {}        → disable all auto-instrumentation
   * - { openAI: OpenAI } → instrument only the provided modules
   *
   * LangChain note: pass `import * as lcCallbackManager from '@langchain/core/callbacks/manager'`
   * as the `langchain` value — NOT the LangChain class itself.
   */
  instrumentModules?: {
    openAI?: unknown;
    anthropic?: unknown;
    langchain?: unknown;
    claudeAgentSDK?: unknown;
    bedrock?: unknown;
  };
  /** Use SimpleSpanProcessor instead of BatchSpanProcessor. Useful for scripts/tests. */
  disableBatch?: boolean;
  /** OTel diagnostic log level. Defaults to 'error'. */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}
