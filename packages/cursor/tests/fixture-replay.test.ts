import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapStreamEvent } from '../src/stream-mapper.js';
import { mapDeltaUpdate } from '../src/delta-mapper.js';
import { mapStatusListener } from '../src/status-mapper.js';
import { ATTR, EVENT, type MapperContext, type SpanOp } from '../src/types.js';
import type { RunStatus } from '@cursor/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

interface CapturedEvent {
  source: 'stream' | 'onDelta' | 'onStep' | 'onDidChangeStatus';
  ts_ms: number;
  ordinal: number;
  payload: unknown;
}

function loadFixture(name: string): CapturedEvent[] {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${name}.json`), 'utf8')) as CapturedEvent[];
}

function unwrapStream(payload: any): any {
  return payload?.event ?? payload;
}
function unwrapDelta(payload: any): any {
  return payload?.update ?? payload;
}
function unwrapStatus(payload: any): RunStatus | undefined {
  if (typeof payload === 'string') return payload as RunStatus;
  return payload?.status as RunStatus | undefined;
}

function isCaptureArtifact(p: any): boolean {
  if (!p || typeof p !== 'object') return false;
  return Boolean(
    p.__caught_error || p.__stream_error || p.__top_level_error || p.__injected || p.__cancel_error,
  );
}

function replay(name: string): SpanOp[] {
  const events = loadFixture(name);
  const ctx: MapperContext = { agentId: '' };
  const ops: SpanOp[] = [];

  for (const e of events) {
    if (e.source === 'stream') {
      const p = unwrapStream(e.payload);
      if (isCaptureArtifact(p)) continue;
      ops.push(...mapStreamEvent(p, ctx));
      if (p?.run_id && !ctx.runId) ctx.runId = p.run_id;
      if (p?.agent_id && !ctx.agentId) ctx.agentId = p.agent_id;
    } else if (e.source === 'onDelta') {
      const p = unwrapDelta(e.payload);
      if (isCaptureArtifact(p)) continue;
      ops.push(...mapDeltaUpdate(p, ctx));
    } else if (e.source === 'onDidChangeStatus') {
      const status = unwrapStatus(e.payload);
      if (status) ops.push(...mapStatusListener(status, ctx));
    }
  }
  return ops;
}

describe('fixture-replay: local-quickstart', () => {
  it('opens and closes a tool span for every tool call (matched by call_id)', () => {
    const ops = replay('local-quickstart');
    const opens = ops.filter(
      (op): op is Extract<SpanOp, { kind: 'OpenToolSpan' }> => op.kind === 'OpenToolSpan',
    );
    const closes = ops.filter(
      (op): op is Extract<SpanOp, { kind: 'CloseToolSpan' }> => op.kind === 'CloseToolSpan',
    );
    expect(opens.length).toBeGreaterThan(0);
    expect(closes.length).toBeGreaterThan(0);
    const closeIds = new Set(closes.map((c) => c.callId));
    for (const o of opens) {
      expect(closeIds.has(o.callId)).toBe(true);
    }
  });

  it('captures token usage on a SetRunAttrs op', () => {
    const ops = replay('local-quickstart');
    const usage = ops.find(
      (op): op is Extract<SpanOp, { kind: 'SetRunAttrs' }> =>
        op.kind === 'SetRunAttrs' &&
        (op.attrs as Record<string, unknown>)[ATTR.USAGE_INPUT] !== undefined,
    );
    expect(usage).toBeDefined();
    const a = usage!.attrs as Record<string, unknown>;
    expect(typeof a[ATTR.USAGE_INPUT]).toBe('number');
    expect(typeof a[ATTR.USAGE_OUTPUT]).toBe('number');
  });

  it('emits assistant.text events with length', () => {
    const ops = replay('local-quickstart');
    const events = ops.filter(
      (op): op is Extract<SpanOp, { kind: 'AddSpanEvent' }> =>
        op.kind === 'AddSpanEvent' && op.name === EVENT.ASSISTANT_TEXT,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(typeof (events[0]!.attrs as Record<string, unknown>)['length']).toBe('number');
  });

  it("closes the run span via the listener with status 'finished'", () => {
    const ops = replay('local-quickstart');
    const close = ops.find(
      (op): op is Extract<SpanOp, { kind: 'CloseRunSpan' }> => op.kind === 'CloseRunSpan',
    );
    expect(close?.terminalStatus).toBe('finished');
  });
});

describe('fixture-replay: local-multiturn', () => {
  it('two distinct run_ids, single shared agent_id', () => {
    const events = loadFixture('local-multiturn');
    const runIds = new Set<string>();
    const agentIds = new Set<string>();
    for (const e of events) {
      if (e.source !== 'stream') continue;
      const p = unwrapStream(e.payload);
      if (p?.run_id) runIds.add(p.run_id);
      if (p?.agent_id) agentIds.add(p.agent_id);
    }
    expect(runIds.size).toBe(2);
    expect(agentIds.size).toBe(1);
  });

  it('emits per-turn usage as 2 separate SetRunAttrs ops with different totals', () => {
    const ops = replay('local-multiturn');
    const usageOps = ops.filter(
      (op): op is Extract<SpanOp, { kind: 'SetRunAttrs' }> =>
        op.kind === 'SetRunAttrs' &&
        (op.attrs as Record<string, unknown>)[ATTR.USAGE_INPUT] !== undefined,
    );
    expect(usageOps.length).toBe(2);
    const u1 = usageOps[0]!.attrs as Record<string, number>;
    const u2 = usageOps[1]!.attrs as Record<string, number>;
    expect(u1[ATTR.USAGE_INPUT]).not.toBe(u2[ATTR.USAGE_INPUT]);
  });

  it("closes 2 run spans via the listener (one per turn), both 'finished'", () => {
    const ops = replay('local-multiturn');
    const closes = ops.filter(
      (op): op is Extract<SpanOp, { kind: 'CloseRunSpan' }> => op.kind === 'CloseRunSpan',
    );
    expect(closes.length).toBe(2);
    expect(closes.every((c) => c.terminalStatus === 'finished')).toBe(true);
  });
});

describe('fixture-replay: local-cancelled', () => {
  it("emits CloseRunSpan with terminalStatus 'cancelled' from listener", () => {
    const ops = replay('local-cancelled');
    const close = ops.find(
      (op): op is Extract<SpanOp, { kind: 'CloseRunSpan' }> => op.kind === 'CloseRunSpan',
    );
    expect(close).toBeDefined();
    expect(close?.terminalStatus).toBe('cancelled');
  });

  it("sets cursor.terminal_status = 'cancelled' before closing", () => {
    const ops = replay('local-cancelled');
    const setAttr = ops.find(
      (op): op is Extract<SpanOp, { kind: 'SetRunAttrs' }> =>
        op.kind === 'SetRunAttrs' &&
        (op.attrs as Record<string, unknown>)[ATTR.TERMINAL_STATUS] === 'cancelled',
    );
    expect(setAttr).toBeDefined();
  });

  it('leaves at least one tool span open at cancel time (mapper-level — runtime closes it later)', () => {
    const ops = replay('local-cancelled');
    const opens = ops.filter(
      (op): op is Extract<SpanOp, { kind: 'OpenToolSpan' }> => op.kind === 'OpenToolSpan',
    );
    const closes = ops.filter(
      (op): op is Extract<SpanOp, { kind: 'CloseToolSpan' }> => op.kind === 'CloseToolSpan',
    );
    const openIds = new Set(opens.map((o) => o.callId));
    const closeIds = new Set(closes.map((c) => c.callId));
    const dangling = [...openIds].filter((id) => !closeIds.has(id));
    expect(dangling.length).toBeGreaterThan(0);
  });
});

describe('fixture-replay: local-errored', () => {
  it('produces zero SpanOps (error fires at Agent.create, before any SDK event)', () => {
    const ops = replay('local-errored');
    expect(ops.length).toBe(0);
  });
});
