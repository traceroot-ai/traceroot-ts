import { trace, type Tracer } from '@opentelemetry/api';
import { mapDeltaUpdate } from './delta-mapper.js';
import { mapStatusListener } from './status-mapper.js';
import { mapStreamEvent, type MapStreamOptions } from './stream-mapper.js';
import { applySpanOps } from './otel-applier.js';
import { SpanManager } from './span-manager.js';
import { getCursorTracer } from './initialize.js';
import { type AdapterOptions, type MapperContext, type Runtime } from './types.js';

const TRACER_NAME = '@traceroot-ai/cursor';
const TRACER_VERSION = '0.0.1';

export interface WrappedAgentOptions extends AdapterOptions {
  tracer?: Tracer;
}

export function wrapAgent<T extends object>(agent: T, options: WrappedAgentOptions = {}): T {
  const tracer =
    options.tracer ?? getCursorTracer() ?? trace.getTracer(TRACER_NAME, TRACER_VERSION);
  const runtime: Runtime = options.runtime ?? 'local';
  const captureBodies = options.captureBodies ?? false;

  return new Proxy(agent, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop === 'send' && typeof original === 'function') {
        const bound = (original as (...args: unknown[]) => unknown).bind(target);
        return makeWrappedSend(bound, target, {
          tracer,
          runtime,
          captureBodies,
          sessionId: options.sessionId,
          userId: options.userId,
        });
      }
      return original;
    },
  }) as T;
}

interface SendBindings {
  tracer: Tracer;
  runtime: Runtime;
  captureBodies: boolean;
  sessionId?: string;
  userId?: string;
}

function makeWrappedSend(
  originalSend: (...args: unknown[]) => unknown,
  agent: object,
  bindings: SendBindings,
) {
  return async function wrappedSend(...args: unknown[]): Promise<unknown> {
    const sendOptions = extractOptions(args);
    const manager = new SpanManager({ tracer: bindings.tracer });

    const agentRecord = agent as Record<string, unknown>;
    const initialAgentId =
      (agentRecord['id'] as string | undefined) ??
      (agentRecord['agentId'] as string | undefined) ??
      'pending';
    const modelId = readModelId(agent, sendOptions);

    manager.openRun({
      agentId: initialAgentId,
      modelId,
      runtime: bindings.runtime,
      sessionId: bindings.sessionId,
      userId: bindings.userId,
    });

    const promptText = extractPromptText(args);
    if (promptText) manager.setRunInput(promptText);

    const ctx: MapperContext = { agentId: initialAgentId };
    const userOnDelta = sendOptions?.['onDelta'] as
      | ((arg: { update: unknown }) => unknown)
      | undefined;

    let outputBuffer = '';

    const wrappedSendOptions: Record<string, unknown> = {
      ...(sendOptions ?? {}),
      onDelta: (arg: { update: unknown }) => {
        try {
          const u = arg.update as { type?: string; text?: string } | undefined;
          if (u?.type === 'text-delta' && typeof u.text === 'string') {
            outputBuffer += u.text;
          }
          const ops = mapDeltaUpdate(arg.update, ctx);
          applySpanOps(manager, ops);
        } catch {
          /* swallow our errors; never break user flow */
        }
        userOnDelta?.(arg);
      },
    };

    const newArgs = buildArgsWithOptions(args, wrappedSendOptions);

    let run: Record<string, unknown>;
    try {
      run = (await originalSend(...newArgs)) as Record<string, unknown>;
    } catch (err) {
      manager.closeRunWithError(err);
      throw err;
    }

    const onDidChange = run['onDidChangeStatus'];
    if (typeof onDidChange === 'function') {
      (onDidChange as (l: (s: unknown) => void) => () => void).call(run, (status) => {
        try {
          if (typeof status === 'string') {
            if (outputBuffer.length > 0) manager.setRunOutput(outputBuffer);
            const ops = mapStatusListener(status as Parameters<typeof mapStatusListener>[0], ctx);
            applySpanOps(manager, ops);
          }
        } catch {
          /* swallow */
        }
      });
    }

    let observerDone: Promise<void> = Promise.resolve();
    const streamFn = run['stream'];
    if (typeof streamFn === 'function') {
      const streamOptions: MapStreamOptions = { captureBodies: bindings.captureBodies };
      observerDone = (async () => {
        try {
          const iter = (streamFn as () => AsyncIterable<unknown>).call(run);
          for await (const event of iter) {
            try {
              const e = event as Record<string, unknown> | null;
              const ops = mapStreamEvent(
                event as Parameters<typeof mapStreamEvent>[0],
                ctx,
                streamOptions,
              );
              applySpanOps(manager, ops);
              const evRunId = e?.['run_id'];
              const evAgentId = e?.['agent_id'];
              if (typeof evRunId === 'string' && !ctx.runId) ctx.runId = evRunId;
              if (typeof evAgentId === 'string' && ctx.agentId === 'pending') {
                ctx.agentId = evAgentId;
              }
            } catch {
              /* per-event swallow */
            }
          }
        } catch {
          /* stream error — surfaced to user via their own iteration */
        }
      })();
      observerDone.catch(() => {});
    }

    const origWait = run['wait'];
    if (typeof origWait === 'function') {
      const boundWait = (origWait as (...a: unknown[]) => Promise<unknown>).bind(run);
      (run as Record<string, unknown>)['wait'] = async (...args: unknown[]) => {
        const result = await boundWait(...args);
        await observerDone.catch(() => {});
        return result;
      };
    }

    return run;
  };
}

function extractPromptText(args: unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const text = (first as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text;
  }
  return undefined;
}

function extractOptions(args: unknown[]): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined;
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && !Array.isArray(last) && !isPromptShape(last)) {
    return last as Record<string, unknown>;
  }
  return undefined;
}

function isPromptShape(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o['text'] === 'string' || Array.isArray(o['images']);
}

function buildArgsWithOptions(args: unknown[], options: Record<string, unknown>): unknown[] {
  if (args.length === 0) return [options];
  if (args.length === 1) {
    const last = args[0];
    if (last && typeof last === 'object' && !Array.isArray(last) && !isPromptShape(last)) {
      return [options];
    }
    return [args[0], options];
  }
  return [...args.slice(0, -1), options];
}

function readModelId(
  agent: object,
  sendOptions: Record<string, unknown> | undefined,
): string | undefined {
  const a = agent as Record<string, unknown>;
  const agentModel = a['model'] as Record<string, unknown> | undefined;
  if (agentModel && typeof agentModel['id'] === 'string') {
    return agentModel['id'] as string;
  }
  const sendModel = sendOptions?.['model'] as Record<string, unknown> | undefined;
  if (sendModel && typeof sendModel['id'] === 'string') {
    return sendModel['id'] as string;
  }
  return undefined;
}
