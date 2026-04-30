import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@cursor/sdk';
import { mapStreamEvent } from '../src/stream-mapper.js';
import { mapDeltaUpdate } from '../src/delta-mapper.js';
import { mapStatusListener } from '../src/status-mapper.js';
import { ATTR, EVENT, type MapperContext, type SpanOp } from '../src/types.js';

function ctx(): MapperContext {
  return { agentId: 'agent-test' };
}

describe('stream-mapper: unknown-event routing for variants not seen in fixtures', () => {
  it('routes SDKSystemMessage (system/init) to cursor.unknown_event', () => {
    const event = {
      type: 'system',
      agent_id: 'a',
      run_id: 'r',
      subtype: 'init',
    } as unknown as SDKMessage;
    const ops = mapStreamEvent(event, ctx());
    const unknown = ops.find(
      (op): op is Extract<SpanOp, { kind: 'AddSpanEvent' }> =>
        op.kind === 'AddSpanEvent' && op.name === EVENT.UNKNOWN,
    );
    expect(unknown).toBeDefined();
    expect((unknown!.attrs as Record<string, unknown>)['kind']).toBe('system');
  });

  it('routes SDKUserMessageEvent to unknown_event', () => {
    const event = {
      type: 'user',
      agent_id: 'a',
      run_id: 'r',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as SDKMessage;
    const ops = mapStreamEvent(event, ctx());
    expect(ops.some((op) => op.kind === 'AddSpanEvent' && op.name === EVENT.UNKNOWN)).toBe(true);
  });

  it('routes SDKTaskMessage to unknown_event', () => {
    const event = { type: 'task', agent_id: 'a', run_id: 'r' } as unknown as SDKMessage;
    const ops = mapStreamEvent(event, ctx());
    expect(ops.some((op) => op.kind === 'AddSpanEvent' && op.name === EVENT.UNKNOWN)).toBe(true);
  });

  it('routes SDKRequestMessage to unknown_event', () => {
    const event = {
      type: 'request',
      agent_id: 'a',
      run_id: 'r',
      request_id: 'req-1',
    } as unknown as SDKMessage;
    const ops = mapStreamEvent(event, ctx());
    expect(ops.some((op) => op.kind === 'AddSpanEvent' && op.name === EVENT.UNKNOWN)).toBe(true);
  });

  it('routes tool_call with unknown status to unknown_event', () => {
    const event = {
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'c',
      name: 'glob',
      status: 'weird-status',
    } as unknown as SDKMessage;
    const ops = mapStreamEvent(event, ctx());
    expect(
      ops.some(
        (op) =>
          op.kind === 'AddSpanEvent' &&
          op.name === EVENT.UNKNOWN &&
          (op.attrs as Record<string, unknown>)['subtype'] === 'unknown_status',
      ),
    ).toBe(true);
  });
});

describe('stream-mapper: SetRunAttrs first-seen behavior', () => {
  it('emits SetRunAttrs once per new run_id (mapper relies on ctx.runId)', () => {
    const c = ctx();
    const event1 = {
      type: 'status',
      agent_id: 'a',
      run_id: 'r1',
      status: 'RUNNING',
    } as unknown as SDKMessage;
    const ops1 = mapStreamEvent(event1, c);
    expect(ops1.some((op) => op.kind === 'SetRunAttrs')).toBe(true);
    c.runId = 'r1';
    const ops2 = mapStreamEvent(event1, c);
    expect(ops2.some((op) => op.kind === 'SetRunAttrs')).toBe(false);
  });
});

describe('stream-mapper: captureBodies option', () => {
  it('includes assistant text body when captureBodies=true', () => {
    const event = {
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    } as unknown as SDKMessage;
    const ops = mapStreamEvent(event, ctx(), { captureBodies: true });
    const evt = ops.find(
      (op): op is Extract<SpanOp, { kind: 'AddSpanEvent' }> =>
        op.kind === 'AddSpanEvent' && op.name === EVENT.ASSISTANT_TEXT,
    );
    expect((evt!.attrs as Record<string, unknown>)['text']).toBe('Hello world');
  });

  it('excludes assistant text body when captureBodies omitted (default)', () => {
    const event = {
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    } as unknown as SDKMessage;
    const ops = mapStreamEvent(event, ctx());
    const evt = ops.find(
      (op): op is Extract<SpanOp, { kind: 'AddSpanEvent' }> =>
        op.kind === 'AddSpanEvent' && op.name === EVENT.ASSISTANT_TEXT,
    );
    const a = evt!.attrs as Record<string, unknown>;
    expect(a['text']).toBeUndefined();
    expect(a['length']).toBe(11);
  });
});

describe('delta-mapper: Zod validation routes failures to unknown_event', () => {
  it('malformed update -> unknown_event with parse_error', () => {
    const malformed = { type: 'tool-call-completed', missing_required: true };
    const ops = mapDeltaUpdate(malformed, ctx());
    const unknown = ops.find(
      (op): op is Extract<SpanOp, { kind: 'AddSpanEvent' }> =>
        op.kind === 'AddSpanEvent' && op.name === EVENT.UNKNOWN,
    );
    expect(unknown).toBeDefined();
    expect((unknown!.attrs as Record<string, unknown>)['parse_error']).toBeDefined();
  });

  it('returns [] for known-skip variant text-delta', () => {
    const ops = mapDeltaUpdate({ type: 'text-delta', text: 'x' }, ctx());
    expect(ops).toEqual([]);
  });
});

describe('status-mapper', () => {
  it("returns [] for non-terminal 'running'", () => {
    expect(mapStatusListener('running', ctx())).toEqual([]);
  });

  it("emits SetRunAttrs + CloseRunSpan for 'error'", () => {
    const ops = mapStatusListener('error', ctx());
    expect(ops.length).toBe(2);
    expect(ops[0]!.kind).toBe('SetRunAttrs');
    expect(ops[1]!.kind).toBe('CloseRunSpan');
    expect((ops[1] as Extract<SpanOp, { kind: 'CloseRunSpan' }>).terminalStatus).toBe('error');
  });

  it("emits SetRunAttrs + CloseRunSpan for 'finished'", () => {
    const ops = mapStatusListener('finished', ctx());
    expect(ops.length).toBe(2);
    expect((ops[1] as Extract<SpanOp, { kind: 'CloseRunSpan' }>).terminalStatus).toBe('finished');
  });

  it("sets cursor.terminal_status = 'cancelled' attr for 'cancelled'", () => {
    const ops = mapStatusListener('cancelled', ctx());
    const setAttr = ops[0] as Extract<SpanOp, { kind: 'SetRunAttrs' }>;
    expect((setAttr.attrs as Record<string, unknown>)[ATTR.TERMINAL_STATUS]).toBe('cancelled');
  });
});
