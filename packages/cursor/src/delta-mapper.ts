import { InteractionUpdateSchema, type InteractionUpdate } from '@cursor/sdk';
import { ATTR, EVENT, TOOL_RESULT_PREVIEW_MAX, type MapperContext, type SpanOp } from './types.js';
import { jsonPreview, jsonSize } from './utils.js';

export function mapDeltaUpdate(update: unknown, _ctx: MapperContext): readonly SpanOp[] {
  const parsed = InteractionUpdateSchema.safeParse(update);
  if (!parsed.success) {
    return [
      {
        kind: 'AddSpanEvent',
        target: 'run',
        name: EVENT.UNKNOWN,
        attrs: {
          kind: (update as { type?: string } | undefined)?.type ?? 'no_type',
          raw_size_bytes: jsonSize(update),
          parse_error: parsed.error.errors
            .slice(0, 3)
            .map((e: { code: string }) => e.code)
            .join(','),
        },
      },
    ];
  }

  return mapValidated(parsed.data as InteractionUpdate);
}

function mapValidated(u: InteractionUpdate): readonly SpanOp[] {
  switch (u.type) {
    case 'tool-call-completed': {
      const view = u as unknown as {
        callId: string;
        toolCall?: {
          type?: string;
          result?: { status?: string; value?: unknown };
        };
      };
      const callId = view.callId;
      const tc = view.toolCall;
      const attrs: Record<string, unknown> = {};
      if (tc?.type !== undefined) attrs[ATTR.TOOL_TYPE] = tc.type;
      if (tc?.result?.status !== undefined) attrs[ATTR.TOOL_RESULT_STATUS] = tc.result.status;
      if (tc?.result?.value !== undefined) {
        attrs[ATTR.TOOL_RESULT_PREVIEW] = jsonPreview(tc.result.value, TOOL_RESULT_PREVIEW_MAX);
      }
      const closeStatus: 'ok' | 'error' = tc?.result?.status === 'success' ? 'ok' : 'error';
      const ops: SpanOp[] = [];
      if (Object.keys(attrs).length > 0) {
        ops.push({ kind: 'EnrichToolSpan', callId, attrs });
      }
      ops.push({ kind: 'CloseToolSpan', callId, status: closeStatus });
      return ops;
    }

    case 'turn-ended': {
      const usage = (
        u as unknown as {
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
        }
      ).usage;
      if (!usage) return [];
      const attrs: Record<string, unknown> = {};
      if (usage.inputTokens !== undefined) attrs[ATTR.USAGE_INPUT] = usage.inputTokens;
      if (usage.outputTokens !== undefined) attrs[ATTR.USAGE_OUTPUT] = usage.outputTokens;
      if (usage.cacheReadTokens !== undefined) attrs[ATTR.USAGE_CACHE_READ] = usage.cacheReadTokens;
      if (usage.cacheWriteTokens !== undefined)
        attrs[ATTR.USAGE_CACHE_WRITE] = usage.cacheWriteTokens;
      return Object.keys(attrs).length === 0 ? [] : [{ kind: 'SetRunAttrs', attrs }];
    }

    case 'tool-call-started': {
      const view = u as unknown as {
        callId: string;
        toolCall?: { type?: string };
      };
      const toolType = view.toolCall?.type ?? 'unknown';
      return [
        { kind: 'OpenToolSpan', callId: view.callId, toolType },
        {
          kind: 'EnrichToolSpan',
          callId: view.callId,
          attrs: {
            [ATTR.TOOL_CALL_ID]: view.callId,
            [ATTR.TOOL_TYPE]: toolType,
          },
        },
      ];
    }

    case 'text-delta':
    case 'token-delta':
    case 'step-completed':
    case 'thinking-delta':
    case 'thinking-completed':
      return [];

    default: {
      const kind = (u as { type?: string }).type ?? 'no_type';
      return [
        {
          kind: 'AddSpanEvent',
          target: 'run',
          name: EVENT.UNKNOWN,
          attrs: {
            kind,
            raw_size_bytes: jsonSize(u),
          },
        },
      ];
    }
  }
}
