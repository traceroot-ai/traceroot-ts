// src/pi-agent-core.ts — instrumentation for @earendil-works/pi-agent-core's standalone
// `Agent` class (prompt() + subscribe()), a narrower surface than pi-coding-agent's
// AgentSession (no steer()/followUp()/dispose()). Reuses pi.ts's span builders
// (openRootSpan/openLlmSpan/openToolSpan/etc.) and its shared AgentEvent union so a
// pi-agent-core trace renders identically to a pi-coding-agent one in the UI.
import {
  context,
  diag,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { OI_OUTPUT_VALUE } from './constants';
import {
  TRACER_NAME,
  resolveConfig,
  openRootSpan,
  stampRootOutput,
  finalizeRootSpan,
  openLlmSpan,
  closeLlmSpan,
  openToolSpan,
  closeToolSpan,
  closeDanglingSpan,
  type AgentEvent,
} from './pi';
import { SDK_VERSION } from './processor';

/**
 * `instrumentModules.piAgentCore` config. Distinct from {@link PiInstrumentationConfig}
 * (pi-coding-agent) because pi-agent-core's Agent has no session/steer/followUp
 * concept, and adds two capabilities pi-coding-agent doesn't need:
 * - `captureToolIo` may be a function, for callers that want to redact/transform
 *   tool args/results rather than a blanket on/off.
 * - `onToolSpan` is a side channel (Task 13/16 in the self-trace plan) for a host
 *   that needs the tool span's own span/trace ids (e.g. to stamp them onto a
 *   persisted tool-step row) without reaching into OTel internals.
 */
export interface PiAgentCoreConfig {
  /** Capture prompt/response text as input.value/output.value on the AGENT and LLM spans. Default true. */
  captureContent?: boolean;
  /**
   * Capture tool call args/results as input.value/output.value on TOOL spans.
   * `true`/`false` behaves like pi-coding-agent's captureToolIo. A function receives
   * the raw args (tool_execution_start) or raw result (tool_execution_end, args
   * undefined) and returns what to record — `result` undefined suppresses just the
   * output side. Default true.
   */
  captureToolIo?:
    | boolean
    | ((toolName: string, args: unknown, result: unknown) => { args?: unknown; result?: string });
  /** Fires at tool_execution_start with the tool span's own ids — a side channel, not a substitute for the span itself. */
  onToolSpan?: (info: { toolCallId: string; spanId: string; traceId: string }) => void;
}

/**
 * Structural shape of `@earendil-works/pi-agent-core`'s `Agent`. Narrower than
 * pi.ts's `AgentSessionInstance`: no steer()/followUp()/dispose() — every run goes
 * through prompt(), so (unlike pi-coding-agent) there is no "stray event before any
 * root exists" scenario to guard against; see handlePiAgentCoreEvent() below.
 */
export interface PiAgentCoreInstance {
  readonly sessionId?: string;
  prompt(text: string, options?: unknown): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export interface PiAgentCoreConstructor {
  prototype: PiAgentCoreInstance;
}

/** Structural shape of the imported `@earendil-works/pi-agent-core` module namespace. */
export interface PiAgentCoreModule {
  Agent?: PiAgentCoreConstructor;
  [key: string]: unknown;
}

// Symbol.for(), not a bare Symbol(): two independently-loaded copies of this package
// must see the same registry key to detect a second instrumentPiAgentCore() call.
// Distinct from pi.ts's own WRAPPED key ('traceroot.pi.wrapped') since it guards a
// different prototype (Agent, not AgentSession). A bracket-notation READ of a Symbol
// key traverses the prototype chain like any other property, so a subclass of an
// already-wrapped Agent is considered already wrapped too (matches pi.ts's own
// WRAPPED semantics — do not switch to hasOwnProperty, which would double-wrap an
// inherited prompt).
const WRAPPED = Symbol.for('traceroot.pi-agent-core.wrapped');

interface RunState {
  root: Span;
  rootCtx: Context;
  llmSpan?: Span;
  llmCtx?: Context;
  tools: Map<string, Span>;
  // Set when a later prompt() on the same Agent took over: the root is already
  // ended, so this run's own settle path must not touch it again.
  superseded?: boolean;
}

// resolve at use, never capture: TraceRoot.shutdown() calls trace.disable(), which
// swaps the OTel proxy provider for a fresh instance. A tracer captured once here
// would stay bound to the old, now-detached provider (identical rationale to
// pi.ts's own instrumentPiCodingAgent()).
function tracer(): Pick<Tracer, 'startSpan'> {
  return {
    startSpan: (name, options, ctx) =>
      trace.getTracer(TRACER_NAME, SDK_VERSION).startSpan(name, options, ctx),
  };
}

// Force-closes every span still open on a run's state (tool spans, then the LLM
// span). The root itself is finalized separately by tracedPrompt's own settle path.
function sweepRunState(state: RunState): void {
  for (const span of state.tools.values()) {
    closeDanglingSpan(span);
  }
  state.tools.clear();
  closeDanglingSpan(state.llmSpan);
  state.llmSpan = undefined;
  state.llmCtx = undefined;
}

/**
 * Resolves a tool's captured args/result for openToolSpan/closeToolSpan: a boolean
 * config passes the raw event value through (openToolSpan/closeToolSpan's own
 * captureToolIo flag then gates whether it's actually serialized); a function
 * transforms it up front, e.g. to redact or replace it with a summary string.
 */
function resolvedToolArgs(config: PiAgentCoreConfig, toolName: string, args: unknown): unknown {
  if (typeof config.captureToolIo !== 'function') return args;
  return config.captureToolIo(toolName, args, undefined).args;
}

function resolvedToolResult(config: PiAgentCoreConfig, toolName: string, result: unknown): unknown {
  if (typeof config.captureToolIo !== 'function') return result;
  return config.captureToolIo(toolName, undefined, result).result;
}

/**
 * Per-run event handler. Guarded by `if (!state) return` rather than falling back to
 * a bare ROOT_CONTEXT/context.active(): unlike pi-coding-agent's AgentSession (which
 * has steer()/followUp() entry points that can emit message_start/tool_execution_start
 * before any prompt() ever ran — see pi.ts's handleEvent() and 07e5dbe's fix to it),
 * pi-agent-core's Agent has no such entry point. Every event this listener sees is
 * necessarily inside a state a tracedPrompt() call created, so there is no
 * "no established root" event to mis-parent in the first place — the class of bug
 * 07e5dbe closed has no fallback site here to reopen.
 */
function handlePiAgentCoreEvent(
  event: AgentEvent,
  config: ReturnType<typeof resolveConfig>,
  rawConfig: PiAgentCoreConfig,
  state: RunState,
): void {
  switch (event.type) {
    case 'message_start': {
      if (event.message.role !== 'assistant') return;
      closeDanglingSpan(state.llmSpan);
      // Same parenting as pi.ts: nests under the root, keyed off rootCtx (never a
      // bare ROOT_CONTEXT — see the function doc above).
      state.llmSpan = openLlmSpan(tracer(), state.rootCtx, event.message);
      state.llmCtx = trace.setSpan(state.rootCtx, state.llmSpan);
      break;
    }
    case 'message_end': {
      if (event.message.role !== 'assistant') return;
      if (state.llmSpan) closeLlmSpan(state.llmSpan, event.message, config.captureContent);
      state.llmSpan = undefined;
      // llmCtx stays alive on purpose: tool_execution_* for this turn fires after
      // message_end (see pi.ts's identical comment) and still parents under it.
      break;
    }
    case 'tool_execution_start': {
      const existing = state.tools.get(event.toolCallId);
      closeDanglingSpan(existing);
      // Tool calls parent under the LLM span that requested them (mirrors pi.ts's
      // handleEvent tool_execution_start), not flatly under the root — this is what
      // makes a pi-agent-core trace's tree shape match a pi-coding-agent one.
      const parentCtx = state.llmCtx ?? state.rootCtx;
      const args = resolvedToolArgs(rawConfig, event.toolName, event.args);
      const span = openToolSpan(
        tracer(),
        parentCtx,
        event.toolCallId,
        event.toolName,
        args,
        config.captureToolIo,
      );
      state.tools.set(event.toolCallId, span);
      const sc = span.spanContext();
      rawConfig.onToolSpan?.({
        toolCallId: event.toolCallId,
        spanId: sc.spanId,
        traceId: sc.traceId,
      });
      break;
    }
    case 'tool_execution_end': {
      const span = state.tools.get(event.toolCallId);
      if (!span) return;
      state.tools.delete(event.toolCallId);
      if (typeof rawConfig.captureToolIo === 'function') {
        // A custom transform bypasses closeToolSpan's own JSON serialization
        // (stringifyToolIo would otherwise quote a plain string like "[withheld]"):
        // set the resolved string verbatim, then let closeToolSpan only apply
        // status/end (captureToolIo: false so it does not also try to serialize).
        const result = resolvedToolResult(rawConfig, event.toolName, event.result) as
          | string
          | undefined;
        if (result !== undefined) span.setAttribute(OI_OUTPUT_VALUE, result);
        closeToolSpan(span, undefined, event.isError, false);
      } else {
        closeToolSpan(span, event.result, event.isError, config.captureToolIo);
      }
      break;
    }
    case 'agent_end': {
      sweepRunState(state);
      stampRootOutput(state.root, event.messages, config.captureContent);
      break;
    }
    case 'turn_end': {
      // Mirrors pi.ts: a stream error can cut a turn short before message_end
      // closed llmSpan; sweep force-closes it (and any open tool spans).
      sweepRunState(state);
      break;
    }
    default:
      break;
  }
}

/**
 * Patches `Agent.prototype.prompt`/`subscribe` from `@earendil-works/pi-agent-core`.
 * On prompt(): the AGENT root span parents on `context.active()` — never a bare
 * ROOT_CONTEXT — so when the host has an active span (including one holding a
 * forced trace id, e.g. TraceRoot's internal-export `observe()` wrapper; see
 * trace-id.ts's forcedTraceRootContext()), the AGENT span nests as a CHILD in that
 * same trace instead of opening a new root. This is the identical guard pi.ts's own
 * `proto.prompt` wrapper already applies for AgentSession, and satisfies the same
 * concern 07e5dbe fixed for pi.ts's OTHER (event-handler) fallback sites — see
 * handlePiAgentCoreEvent()'s doc comment for why no such fallback site exists here.
 */
export function instrumentPiAgentCore(sdk: unknown, config: PiAgentCoreConfig = {}): unknown {
  const mod = sdk as PiAgentCoreModule;
  const proto = mod?.Agent?.prototype as
    | (PiAgentCoreInstance & { [WRAPPED]?: boolean })
    | undefined;
  if (typeof proto?.prompt !== 'function' || typeof proto?.subscribe !== 'function') {
    throw new Error(
      '[traceroot-pi-agent-core] Agent.prototype.prompt/subscribe not found — cannot install instrumentation.',
    );
  }
  if (proto[WRAPPED]) return sdk;

  const resolved = resolveConfig({
    captureContent: config.captureContent,
    // A function transform still gates the boolean serialization path "on" — the
    // transform itself decides what (if anything) gets captured.
    captureToolIo: config.captureToolIo !== false,
  });

  const states = new WeakMap<PiAgentCoreInstance, RunState>();
  const subscribed = new WeakSet<PiAgentCoreInstance>();

  const ensureSubscribed = (agent: PiAgentCoreInstance): void => {
    if (subscribed.has(agent)) return;
    subscribed.add(agent);
    agent.subscribe((event: AgentEvent) => {
      const state = states.get(agent);
      if (!state) return;
      // Instrumentation must never abort the run: a throwing captureToolIo /
      // onToolSpan (or a span builder) is logged and the agent carries on.
      try {
        handlePiAgentCoreEvent(event, resolved, config, state);
      } catch (err) {
        diag.warn('[traceroot-pi-agent-core] instrumentation error (agent run continues):', err);
      }
    });
  };

  const originalPrompt = proto.prompt;
  const tracedPrompt = function (this: PiAgentCoreInstance, text: string, options?: unknown) {
    ensureSubscribed(this);

    const parentCtx = context.active();
    const root = openRootSpan(tracer(), parentCtx, {
      text: typeof text === 'string' ? text : undefined,
      sessionId: this.sessionId,
      captureContent: resolved.captureContent,
    });
    root.updateName('Agent.prompt');
    const rootCtx = trace.setSpan(parentCtx, root);
    const state: RunState = { root, rootCtx, tools: new Map() };
    // One RunState per Agent: a second prompt() overlapping the first would
    // otherwise route both runs' events into whichever state was set last, and
    // the first run's settle path would delete the second's state. Close the
    // prior run out as superseded (its spans force_closed) before replacing it.
    const prior = states.get(this);
    if (prior) {
      prior.superseded = true;
      sweepRunState(prior);
      finalizeRootSpan(prior.root, 0, {
        code: SpanStatusCode.ERROR,
        message: 'superseded by an overlapping prompt() on the same Agent',
      });
    }
    states.set(this, state);

    const finalize = (
      status: { code: SpanStatusCode; message?: string },
      error?: unknown,
    ): void => {
      sweepRunState(state);
      // Only the current run may clear the slot; a superseded run finalizing
      // late must not delete the run that replaced it.
      if (states.get(this) === state) states.delete(this);
      // A superseded run's root was already ended (as ERROR) by the prompt()
      // that replaced it; ending it twice would only log an OTel warning.
      if (state.superseded) return;
      finalizeRootSpan(root, 0, status, error);
    };

    let result: Promise<void>;
    try {
      result = context.with(rootCtx, () => originalPrompt.call(this, text, options));
    } catch (err) {
      finalize({ code: SpanStatusCode.ERROR, message: String(err) }, err);
      throw err;
    }
    return result.then(
      (value) => {
        finalize({ code: SpanStatusCode.OK });
        return value;
      },
      (err: unknown) => {
        finalize(
          { code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) },
          err,
        );
        throw err;
      },
    );
  };
  proto.prompt = tracedPrompt;
  Object.defineProperty(proto, WRAPPED, { value: true, enumerable: false });

  return sdk;
}
