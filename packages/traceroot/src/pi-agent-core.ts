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
  recordToolArgs,
  closeToolSpan,
  closeDanglingSpan,
  applyCaptureAttributes,
  type AgentEvent,
  type AgentMessage,
  type AssistantMessage,
  type CaptureContext,
  type ContentCapture,
} from './pi';
import { SDK_VERSION } from './processor';

/**
 * `instrumentModules.piAgentCore` config. Distinct from {@link PiInstrumentationConfig}
 * (pi-coding-agent) because pi-agent-core's Agent has no session/steer/followUp
 * concept, and adds two capabilities pi-coding-agent doesn't need:
 * - `captureToolIo` may be a {@link ToolIoCapture}, for callers that want to
 *   redact/transform tool args/results rather than a blanket on/off.
 * - `onToolSpan` is a side channel (Task 13/16 in the self-trace plan) for a host
 *   that needs the tool span's own span/trace ids (e.g. to stamp them onto a
 *   persisted tool-step row) without reaching into OTel internals.
 */
export interface PiAgentCoreConfig {
  /**
   * Capture prompt/response text as input.value/output.value on the AGENT and LLM
   * spans. `true` (default) records them as-is, `false` records none, a function
   * decides per piece (and is the only form that records a model call's input
   * messages, read from `agent.state` at message_start). See pi.ts's ContentCapture.
   */
  captureContent?: ContentCapture;
  /**
   * Capture tool call args/results as input.value/output.value on TOOL spans.
   * `true`/`false` behaves like pi-coding-agent's captureToolIo; a
   * {@link ToolIoCapture} decides per call. Default true.
   */
  captureToolIo?: boolean | ToolIoCapture;
  /** Fires at tool_execution_start with the tool span's own ids — a side channel, not a substitute for the span itself. */
  onToolSpan?: (info: { toolCallId: string; spanId: string; traceId: string }) => void;
  /**
   * Whether each prompt() opens its own AGENT span (`Agent.prompt`).
   * `'always'` (default): it does, as the root when nothing is active and as a
   * child of the active span otherwise. `'unless-nested'`: when a recording
   * span is already active, no AGENT span is opened and the run's LLM and
   * TOOL spans hang directly off the active span — for a host that opens its
   * own root around the run and records the prompt and the answer there, so
   * an `Agent.prompt` layer would only repeat it (or, with captureContent
   * narrowing it out, sit empty). Without an active span the AGENT span is
   * still opened: a run must have a root to be a trace at all.
   */
  agentSpan?: 'always' | 'unless-nested';
}

/** What a {@link ToolIoCapture} is told about the call it is capturing. */
export interface ToolIoCaptureContext extends CaptureContext {
  /** pi-agent-core's id for this tool call: the same on the args and the result side. */
  toolCallId: string;
}

/**
 * Decides what lands on a TOOL span for one call, one side at a time. `args`
 * runs at tool_execution_start and returns the value to record as input
 * (serialised by the instrumentation; `undefined` records nothing); `result`
 * runs at tool_execution_end and returns the output text verbatim (`undefined`
 * records nothing). Both see the call's id, so a host can pair the two sides
 * under one budget, and both may set attributes on the span through the
 * context. Neither runs for a span that is not recording. A throw records
 * nothing for that side and never aborts the run.
 */
export interface ToolIoCapture {
  args(toolName: string, args: unknown, ctx: ToolIoCaptureContext): unknown;
  result(toolName: string, result: unknown, ctx: ToolIoCaptureContext): string | undefined;
}

/**
 * Structural shape of `@earendil-works/pi-agent-core`'s `Agent`. Narrower than
 * pi.ts's `AgentSessionInstance`: no steer()/followUp()/dispose() — every run goes
 * through prompt(), so (unlike pi-coding-agent) there is no "stray event before any
 * root exists" scenario to guard against; see handlePiAgentCoreEvent() below.
 */
export interface PiAgentCoreInstance {
  readonly sessionId?: string;
  /** pi-agent-core's public AgentState; read at message_start for a captureContent function's llm_input. */
  readonly state?: { readonly messages?: readonly AgentMessage[]; readonly systemPrompt?: string };
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
  agent: PiAgentCoreInstance;
  /** The run's own AGENT span; absent when the run nests under the host's span (agentSpan: 'unless-nested'). */
  root?: Span;
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
 * The messages this model call was given, for a captureContent function's
 * `llm_input`. pi-agent-core has already appended the (still empty) assistant
 * message being streamed when message_start fires, so it is dropped from the end.
 * Any failure reading the state records nothing rather than aborting the run.
 */
function llmInputMessages(
  agent: PiAgentCoreInstance,
  current: AssistantMessage,
): readonly AgentMessage[] | undefined {
  try {
    const messages = agent.state?.messages;
    if (!Array.isArray(messages)) return undefined;
    const last = messages[messages.length - 1];
    return last === current ? messages.slice(0, -1) : messages;
  } catch {
    return undefined;
  }
}

function toolIoCapture(config: PiAgentCoreConfig): ToolIoCapture | undefined {
  return typeof config.captureToolIo === 'object' ? config.captureToolIo : undefined;
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
      state.llmSpan = openLlmSpan(tracer(), state.rootCtx, event.message, {
        captureContent: config.captureContent,
        messages: llmInputMessages(state.agent, event.message),
        systemPrompt: state.agent.state?.systemPrompt,
      });
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
      const capture = toolIoCapture(rawConfig);
      // With a capture the span opens bare (name and input come from what the
      // capture returns), and the capture only runs for a recording span: a
      // host with tracing off must not pay for it on every call. A throwing
      // args capture records nothing (never the raw args) — the span is still
      // registered, so the result side and the close still find it.
      const span = openToolSpan(
        tracer(),
        parentCtx,
        event.toolCallId,
        event.toolName,
        capture ? undefined : event.args,
        capture ? false : config.captureToolIo,
      );
      state.tools.set(event.toolCallId, span);
      if (capture && span.isRecording()) {
        const ctx: ToolIoCaptureContext = { toolCallId: event.toolCallId, attributes: {} };
        try {
          recordToolArgs(span, event.toolName, capture.args(event.toolName, event.args, ctx));
          applyCaptureAttributes(span, ctx);
        } catch (err) {
          diag.warn('[traceroot-pi-agent-core] args capture threw; recording nothing:', err);
        }
      }
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
      const capture = toolIoCapture(rawConfig);
      if (capture) {
        // A capture bypasses closeToolSpan's own JSON serialization
        // (stringifyToolIo would otherwise quote a plain string like "[withheld]"):
        // set the returned string verbatim, then let closeToolSpan only apply
        // status/end (captureToolIo: false so it does not also try to serialize).
        // The span is closed whatever the capture does: a throwing result
        // capture used to leave it open forever (deleted from the map above,
        // so the run-end sweep could not find it either) and the tool span a
        // host had already been handed the id of never reached the exporter.
        // A failed capture records no output — never the raw result.
        try {
          if (span.isRecording()) {
            const ctx: ToolIoCaptureContext = { toolCallId: event.toolCallId, attributes: {} };
            const result = capture.result(event.toolName, event.result, ctx);
            if (result !== undefined) span.setAttribute(OI_OUTPUT_VALUE, result);
            applyCaptureAttributes(span, ctx);
          }
        } finally {
          closeToolSpan(span, undefined, event.isError, false);
        }
      } else {
        closeToolSpan(span, event.result, event.isError, config.captureToolIo);
      }
      break;
    }
    case 'agent_end': {
      sweepRunState(state);
      // Without an own AGENT span the answer belongs to the host's span, which
      // the host records itself.
      if (state.root) stampRootOutput(state.root, event.messages, config.captureContent);
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
    // A ToolIoCapture still gates the boolean serialization path "on" — the
    // capture itself decides what (if anything) gets recorded.
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
    // A host that opened its own span around the run, and asked for it, gets
    // the run's children directly: no AGENT span of ours in between.
    const activeParent = trace.getSpan(parentCtx);
    const nested =
      config.agentSpan === 'unless-nested' &&
      activeParent !== undefined &&
      activeParent.isRecording();
    const root = nested
      ? undefined
      : openRootSpan(tracer(), parentCtx, {
          text: typeof text === 'string' ? text : undefined,
          sessionId: this.sessionId,
          captureContent: resolved.captureContent,
        });
    root?.updateName('Agent.prompt');
    const rootCtx = root ? trace.setSpan(parentCtx, root) : parentCtx;
    const state: RunState = { agent: this, root, rootCtx, tools: new Map() };
    // One RunState per Agent: a second prompt() overlapping the first would
    // otherwise route both runs' events into whichever state was set last, and
    // the first run's settle path would delete the second's state. Close the
    // prior run out as superseded (its spans force_closed) before replacing it.
    const prior = states.get(this);
    if (prior) {
      prior.superseded = true;
      sweepRunState(prior);
      if (prior.root) {
        finalizeRootSpan(prior.root, 0, {
          code: SpanStatusCode.ERROR,
          message: 'superseded by an overlapping prompt() on the same Agent',
        });
      }
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
      // that replaced it; ending it twice would only log an OTel warning. A
      // nested run has no root of its own: its outcome is the host's to record.
      if (state.superseded || !root) return;
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
