// src/types.ts
import type { PiInstrumentationConfig } from './pi';

export type SpanType = 'span' | 'agent' | 'tool' | 'llm';

/**
 * The object form of `instrumentModules.piCodingAgent`: the
 * `@earendil-works/pi-coding-agent` module ref bundled with an explicit
 * {@link PiInstrumentationConfig}. Use this instead of the bare module ref
 * when you need to override capture behavior (e.g. `captureContent: false`
 * or `captureToolIo: false` for PII control). This in-tree integration
 * builds no export pipeline of its own -- there is no apiKey/baseUrl here to
 * override; it always gets its tracer from the globally-registered OTel
 * provider core (`TraceRoot.initialize()`) already set up.
 */
export interface PiCodingAgentInstrumentation {
  /** `import * as pi from '@earendil-works/pi-coding-agent'`. */
  module: unknown;
  /** Explicit pi instrumentation config (captureContent/captureToolIo); overrides the defaults. */
  config?: PiInstrumentationConfig;
}

export interface ObserveOptions {
  /** Span name. Defaults to fn.name, then 'anonymous'. */
  name?: string;
  /** Span kind. Defaults to 'span' → openinference.span.kind = 'CHAIN'. */
  type?: SpanType;
  /** Arbitrary metadata to attach to this span. */
  metadata?: Record<string, unknown>;
  /** Tags to attach to this span. */
  tags?: string[];
  /**
   * Whether to auto-capture function arguments as input.value. Defaults to true.
   * Set to false to suppress input recording (e.g. for PII or non-serializable args).
   * Only applies when args are passed: observe(opts, fn, arg1, arg2).
   */
  captureInput?: boolean;
  /**
   * Whether to capture the return value as output.value. Defaults to true.
   * Set to false to suppress output recording (e.g. for large or sensitive responses).
   */
  captureOutput?: boolean;
  /**
   * Session / conversation ID to associate with this span.
   * Equivalent to calling updateCurrentTrace({ sessionId }) inside fn.
   */
  sessionId?: string;
  /**
   * User ID to associate with this span.
   * Equivalent to calling updateCurrentTrace({ userId }) inside fn.
   */
  userId?: string;
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
    /**
     * @openai/agents module ref. Pass `import * as agents from '@openai/agents'`.
     *
     * Replaces the SDK's default OpenAI tracing processor with TraceRoot's —
     * spans go to TraceRoot only, NOT to OpenAI's tracing backend.
     * To dual-export, call `addTraceProcessor(...)` from `@openai/agents`
     * after `initialize()`.
     */
    openaiAgents?: unknown;
    /**
     * @earendil-works/pi-coding-agent instrumentation, built in to this
     * package (packages/traceroot/src/pi.ts). Accepts either:
     *  - the bare module ref: `import * as pi from '@earendil-works/pi-coding-agent'`; or
     *  - a {@link PiCodingAgentInstrumentation} wrapper: `{ module: pi, config: {...} }`,
     *    to override capture behavior (`captureContent`/`captureToolIo`) —
     *    the deliberate divergence from {@link claudeAgentSDK}, which has no
     *    config at all.
     *
     * Delegates directly to instrumentPiCodingAgent() (./pi.ts),
     * which auto-discovers the already-registered global OTel provider core
     * sets up, so pi's spans land in the same shared pipeline as the rest of
     * TraceRoot's traces. No separate package install, no lazy-loading, and
     * no apiKey/baseUrl threading — this in-tree integration never builds an
     * export pipeline of its own.
     */
    piCodingAgent?: unknown;
  };
  /** Use SimpleSpanProcessor instead of BatchSpanProcessor. Useful for scripts/tests. */
  disableBatch?: boolean;
  /** OTel diagnostic log level. Defaults to 'error'. */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Disable all tracing. Falls back to TRACEROOT_ENABLED env var ('false' disables).
   * When false, initialize() is a no-op and no spans are recorded.
   */
  enabled?: boolean;
  /**
   * Deployment environment tag (e.g. 'production', 'staging').
   * Falls back to TRACEROOT_ENVIRONMENT env var.
   * Stamped on every span as 'deployment.environment'.
   */
  environment?: string;
  /**
   * Git repository in normalized 'owner/repo' form (e.g. 'acme/my-service').
   * Falls back to TRACEROOT_GIT_REPO env var, then auto-detected via `git remote get-url origin`.
   */
  gitRepo?: string;
  /**
   * Git commit SHA (typically a 40-character hash). Falls back to TRACEROOT_GIT_REF env var,
   * then auto-detected via `git rev-parse HEAD`.
   */
  gitRef?: string;
}

/** LLM token usage. Known fields map to OpenInference token-count keys;
 *  extra keys are preserved in the traceroot.llm.usage blob. */
export interface TokenUsage {
  /** Uncached prompt tokens. */
  input?: number;
  /** Completion tokens. */
  output?: number;
  /** Cache-read (Anthropic cache_read_input_tokens). */
  cacheRead?: number;
  /** Cache-write / creation (Anthropic cache_creation_input_tokens). */
  cacheWrite?: number;
  /** Total; derived from prompt+completion if omitted. */
  total?: number;
  [key: string]: number | undefined;
}

export interface StartSpanOptions {
  name: string;
  type?: SpanType;
  input?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  sessionId?: string;
  userId?: string;
  model?: string;
  modelParameters?: Record<string, unknown>;
  /** Arbitrary span attributes (see {@link SpanUpdate.attributes}). */
  attributes?: Record<string, string | number | boolean>;
  /** Explicit parent handle. Default: the current active span. */
  parent?: import('./spans').Span;
}

export interface SpanUpdate {
  name?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, unknown>;
  usage?: TokenUsage;
  /**
   * Arbitrary span attributes for keys the typed fields above don't cover
   * (e.g. `gen_ai.*` semconv keys, domain-specific tags). Set through to the
   * underlying span verbatim — the escape hatch so callers never need raw
   * OpenTelemetry for a one-off attribute.
   */
  attributes?: Record<string, string | number | boolean>;
}
