import {
  context as otelContext,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  ATTR,
  INPUT_PREVIEW_MAX,
  OI_KIND,
  OUTPUT_PREVIEW_MAX,
  SPAN,
  type Runtime,
  type SpanTarget,
  type TerminalStatus,
  type ToolCloseStatus,
} from './types.js';
import { errorPreview, truncate } from './utils.js';

export interface SpanManagerOptions {
  tracer: Tracer;
}

type AttrValue = string | number | boolean;

function coerceAttrs(attrs: Record<string, unknown>): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

export class SpanManager {
  private readonly tracer: Tracer;
  private runSpan: Span | undefined;
  private readonly toolSpans = new Map<string, Span>();
  private closed = false;

  constructor(opts: SpanManagerOptions) {
    this.tracer = opts.tracer;
  }

  openRun(args: {
    agentId: string;
    modelId?: string;
    runtime: Runtime;
    sessionId?: string;
    userId?: string;
  }): void {
    if (this.runSpan) return;
    const attrs: Record<string, AttrValue> = {
      [ATTR.AGENT_ID]: args.agentId,
      [ATTR.RUNTIME]: args.runtime,
      [ATTR.OI_SPAN_KIND]: OI_KIND.AGENT,
    };
    if (args.modelId) {
      attrs[ATTR.MODEL_ID] = args.modelId;
      attrs[ATTR.OI_MODEL_NAME] = args.modelId;
    }
    if (args.sessionId) {
      attrs[ATTR.SESSION_ID] = args.sessionId;
      attrs[ATTR.OI_SESSION_ID] = args.sessionId;
    }
    if (args.userId) {
      attrs[ATTR.USER_ID] = args.userId;
      attrs[ATTR.OI_USER_ID] = args.userId;
    }
    this.runSpan = this.tracer.startSpan(SPAN.RUN, { attributes: attrs });
  }

  setRunAttrs(attrs: Record<string, unknown>): void {
    if (!this.runSpan) return;
    const coerced = coerceAttrs(attrs);

    const input = coerced[ATTR.USAGE_INPUT];
    const output = coerced[ATTR.USAGE_OUTPUT];
    if (typeof input === 'number') coerced[ATTR.OI_TOKEN_PROMPT] = input;
    if (typeof output === 'number') coerced[ATTR.OI_TOKEN_COMPLETION] = output;
    if (typeof input === 'number' && typeof output === 'number') {
      coerced[ATTR.OI_TOKEN_TOTAL] = input + output;
    }

    this.runSpan.setAttributes(coerced);
  }

  setRunInput(text: string): void {
    if (!this.runSpan) return;
    this.runSpan.setAttribute(ATTR.OI_INPUT_VALUE, truncate(text, INPUT_PREVIEW_MAX));
  }

  setRunOutput(text: string): void {
    if (!this.runSpan) return;
    this.runSpan.setAttribute(ATTR.OI_OUTPUT_VALUE, truncate(text, OUTPUT_PREVIEW_MAX));
  }

  openTool(callId: string, toolType: string): void {
    if (this.toolSpans.has(callId)) return;
    const ctx = this.runSpan
      ? trace.setSpan(otelContext.active(), this.runSpan)
      : otelContext.active();
    const span = this.tracer.startSpan(`${SPAN.TOOL_PREFIX}${toolType}`, {}, ctx);
    span.setAttributes({
      [ATTR.TOOL_CALL_ID]: callId,
      [ATTR.TOOL_TYPE]: toolType,
      [ATTR.OI_SPAN_KIND]: OI_KIND.TOOL,
    });
    this.toolSpans.set(callId, span);
  }

  enrichTool(callId: string, attrs: Record<string, unknown>): void {
    const span = this.toolSpans.get(callId);
    if (!span) return;
    span.setAttributes(coerceAttrs(attrs));
  }

  closeTool(callId: string, status?: ToolCloseStatus): void {
    const span = this.toolSpans.get(callId);
    if (!span) return;
    if (status === 'error') {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } else if (status === 'cancelled') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'cancelled' });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
    this.toolSpans.delete(callId);
  }

  addEvent(
    target: SpanTarget,
    callId: string | undefined,
    name: string,
    attrs: Record<string, unknown>,
  ): void {
    const coerced = coerceAttrs(attrs);
    if (target === 'run') {
      this.runSpan?.addEvent(name, coerced);
      return;
    }
    if (target === 'tool' && callId) {
      this.toolSpans.get(callId)?.addEvent(name, coerced);
    }
  }

  closeRun(terminalStatus: TerminalStatus): void {
    if (this.closed) return;

    for (const [, span] of this.toolSpans) {
      if (terminalStatus === 'cancelled') {
        span.setAttributes({ [ATTR.TOOL_TERMINATED_BY_CANCEL]: true });
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'terminated by cancel' });
      } else if (terminalStatus === 'error') {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    }
    this.toolSpans.clear();

    if (this.runSpan) {
      this.runSpan.setAttributes({ [ATTR.TERMINAL_STATUS]: terminalStatus });
      if (terminalStatus === 'error') {
        this.runSpan.setStatus({ code: SpanStatusCode.ERROR });
      } else if (terminalStatus === 'cancelled') {
        this.runSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'cancelled' });
      } else {
        this.runSpan.setStatus({ code: SpanStatusCode.OK });
      }
      this.runSpan.end();
      this.runSpan = undefined;
    }
    this.closed = true;
  }

  closeRunWithError(err: unknown): void {
    if (this.closed) return;
    if (!this.runSpan) {
      this.runSpan = this.tracer.startSpan(SPAN.RUN);
    }
    const e = err as { name?: string; message?: string };
    const errClass = e?.name ?? 'Error';
    const errMsg = errorPreview(e?.message ?? '');
    this.runSpan.setAttributes({
      [ATTR.ERROR_CLASS]: errClass,
      [ATTR.ERROR_MESSAGE_PREVIEW]: errMsg,
    });
    this.closeRun('error');
  }
}
