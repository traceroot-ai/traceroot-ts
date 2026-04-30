import type { SDKMessage } from '@cursor/sdk';
import {
  ASSISTANT_TEXT_PREVIEW_MAX,
  ATTR,
  EVENT,
  type MapperContext,
  type SpanOp,
} from './types.js';
import { jsonSize, truncate } from './utils.js';

export interface MapStreamOptions {
  captureBodies?: boolean;
}

export function mapStreamEvent(
  event: SDKMessage,
  ctx: MapperContext,
  options: MapStreamOptions = {},
): readonly SpanOp[] {
  const ops: SpanOp[] = [];

  if ('run_id' in event && ctx.runId !== event.run_id) {
    ops.push({
      kind: 'SetRunAttrs',
      attrs: {
        [ATTR.RUN_ID]: event.run_id,
        [ATTR.AGENT_ID]: event.agent_id,
      },
    });
  }

  switch (event.type) {
    case 'assistant': {
      const text = event.message.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const attrs: Record<string, unknown> = { length: text.length };
      if (options.captureBodies) {
        attrs['text'] = truncate(text, ASSISTANT_TEXT_PREVIEW_MAX);
      }
      ops.push({
        kind: 'AddSpanEvent',
        target: 'run',
        name: EVENT.ASSISTANT_TEXT,
        attrs,
      });
      return ops;
    }

    case 'tool_call': {
      if (event.status === 'running') {
        ops.push({
          kind: 'OpenToolSpan',
          callId: event.call_id,
          toolType: event.name,
        });
        const enrichAttrs: Record<string, unknown> = {
          [ATTR.TOOL_CALL_ID]: event.call_id,
          [ATTR.TOOL_TYPE]: event.name,
        };
        if (event.truncated?.args !== undefined) {
          enrichAttrs[ATTR.TOOL_ARGS_TRUNCATED] = event.truncated.args;
        }
        if (event.truncated?.result !== undefined) {
          enrichAttrs[ATTR.TOOL_RESULT_TRUNCATED] = event.truncated.result;
        }
        ops.push({
          kind: 'EnrichToolSpan',
          callId: event.call_id,
          attrs: enrichAttrs,
        });
        return ops;
      }
      if (event.status === 'completed') {
        ops.push({ kind: 'CloseToolSpan', callId: event.call_id, status: 'ok' });
        return ops;
      }
      if (event.status === 'error') {
        ops.push({ kind: 'CloseToolSpan', callId: event.call_id, status: 'error' });
        return ops;
      }
      ops.push({
        kind: 'AddSpanEvent',
        target: 'run',
        name: EVENT.UNKNOWN,
        attrs: {
          kind: 'tool_call',
          subtype: 'unknown_status',
          raw_size_bytes: jsonSize(event),
        },
      });
      return ops;
    }

    case 'thinking': {
      const attrs: Record<string, unknown> = { length: event.text.length };
      if (event.thinking_duration_ms !== undefined) {
        attrs['thinking_duration_ms'] = event.thinking_duration_ms;
      }
      ops.push({
        kind: 'AddSpanEvent',
        target: 'run',
        name: EVENT.THINKING,
        attrs,
      });
      return ops;
    }

    case 'status': {
      return ops;
    }

    default: {
      const kind = (event as { type?: string }).type ?? 'no_type';
      ops.push({
        kind: 'AddSpanEvent',
        target: 'run',
        name: EVENT.UNKNOWN,
        attrs: {
          kind,
          raw_size_bytes: jsonSize(event),
        },
      });
      return ops;
    }
  }
}
