// Parity with traceroot-py tests/eval/test_runner_robustness.py — declared-threshold verdicts,
// unserializable payloads, hook isolation, and the flush-before-exit guarantee.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Emitter, makeRunResult, runSuite, writeArtifacts } from '../src/eval';
import { main } from '../src/eval/runner';
import { TraceRoot } from '../src/traceroot';

const EVAL_IMPORT = join(__dirname, '..', 'src', 'eval').replace(/\\/g, '/');

const THRESHOLD_EVAL = `
import { Dataset, Evaluation, scorer } from '${EVAL_IMPORT}';
const quality = scorer((_ctx: any) => 0.9, { name: 'quality', valueType: 'numeric', threshold: 0.8 });
const ds = new Dataset('d');
ds.add(1, { id: 'c0', expected: 1 });
export const thresholdEval = new Evaluation({ name: 'thresh', dataset: ds, task: (x: any) => x, scorers: [quality] });
`;

const LOWER_IS_BETTER_EVAL = `
import { Dataset, Evaluation, scorer } from '${EVAL_IMPORT}';
const latency = scorer((ctx: any) => (ctx.input === 'at' ? 0.5 : 0.6), { name: 'latency', valueType: 'numeric', direction: 'lower_is_better', threshold: 0.5 });
const ds = new Dataset('d');
ds.add('at', { id: 'at' });
ds.add('over', { id: 'over' });
export const latencyEval = new Evaluation({ name: 'lat', dataset: ds, task: (x: any) => x, scorers: [latency] });
`;

const NO_THRESHOLD_EVAL = `
import { Dataset, Evaluation } from '${EVAL_IMPORT}';
function score(_ctx: any) { return 0.9; }
const ds = new Dataset('d');
ds.add(1, { id: 'c0', expected: 1 });
export const undeclaredEval = new Evaluation({ name: 'undeclared', dataset: ds, task: (x: any) => x, scorers: [score] });
`;

const BIGINT_EVAL = `
import { Dataset, Evaluation } from '${EVAL_IMPORT}';
function task(_x: any) { return { total: BigInt(9007199254740993n) }; }
function acc(_ctx: any) { return 1.0; }
const ds = new Dataset('d');
ds.add(1, { id: 'c0', expected: 1 });
ds.add(2, { id: 'c1', expected: 2 });
export const bigintEval = new Evaluation({ name: 'bigint', dataset: ds, task, scorers: [acc] });
`;

const CYCLIC_EVAL = `
import { Dataset, Evaluation } from '${EVAL_IMPORT}';
function task(x: any) { const out: any = { case: x }; out.self = out; return out; }
function acc(_ctx: any) { return 1.0; }
const ds = new Dataset('d');
ds.add(1, { id: 'c0', expected: 1 });
ds.add(2, { id: 'c1', expected: 2 });
export const cyclicEval = new Evaluation({ name: 'cyclic', dataset: ds, task, scorers: [acc] });
`;

const TWO_CASE_EVAL = `
import { Dataset, Evaluation, FakeTransport } from '${EVAL_IMPORT}';
function acc(_ctx: any) { return 1.0; }
const ds = new Dataset('d');
ds.add(1, { id: 'c0', expected: 1 });
ds.add(2, { id: 'c1', expected: 2 });
export const twoEval = new Evaluation({ name: 'two', dataset: ds, task: (x: any) => x, scorers: [acc], transport: new FakeTransport() });
`;

let dir: string;
const realFlush = TraceRoot.flush;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-robust-'));
});
afterEach(() => {
  TraceRoot.flush = realFlush;
  delete process.env['TRACEROOT_ENABLED'];
  delete process.env['TRACEROOT_EVAL_OPTIONS'];
  delete process.env['TRACEROOT_EVAL_EVENT_FILE'];
});

function writeEval(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

async function collect(
  paths: string[],
  options: Record<string, unknown>,
): Promise<Record<string, any>[]> {
  const events: Record<string, any>[] = [];
  await runSuite(paths, options, new Emitter((ln) => events.push(JSON.parse(ln))));
  return events;
}

function scoresFor(events: Record<string, any>[], caseId: string): Record<string, any>[] {
  return events.find((e) => e.type === 'case_completed' && e.case_id === caseId)!.scores;
}

function caseRecords(events: Record<string, any>[], out: string): Record<string, any>[] {
  const done = events.find((e) => e.type === 'evaluation_completed')!;
  const text = readFileSync(join(out, `${done.local_run_id}.cases.jsonl`), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

describe('runner: declared-threshold verdicts', () => {
  // The local artifact's `passed` must come from the scorer's DECLARED policy — the same
  // resolution the platform applies — or the two disagree about the same score.
  it('a score above the declared threshold passes', async () => {
    const file = writeEval('thresh_eval.ts', THRESHOLD_EVAL);
    const events = await collect([file], { no_artifact: true });
    // 0.9 >= declared threshold 0.8 -> pass (a hardcoded >= 1.0 would call this a failure).
    assert.equal(scoresFor(events, 'c0')[0].passed, true);
  });

  it('lower_is_better compares in the declared direction, boundary included', async () => {
    const file = writeEval('lat_eval.ts', LOWER_IS_BETTER_EVAL);
    const events = await collect([file], { no_artifact: true });
    assert.equal(scoresFor(events, 'at')[0].passed, true); // 0.5 <= 0.5
    assert.equal(scoresFor(events, 'over')[0].passed, false); // 0.6 > 0.5
  });

  it('a scorer with no declared threshold gets no verdict', async () => {
    const file = writeEval('undeclared_eval.ts', NO_THRESHOLD_EVAL);
    const events = await collect([file], { no_artifact: true });
    assert.equal(scoresFor(events, 'c0')[0].passed, null);
  });

  it('the artifact agrees with the event stream', async () => {
    const file = writeEval('thresh_eval.ts', THRESHOLD_EVAL);
    const out = join(dir, 'runs');
    const events = await collect([file], { out_dir: out });
    const done = events.find((e) => e.type === 'evaluation_completed')!;
    const runDoc = JSON.parse(readFileSync(join(out, `${done.local_run_id}.json`), 'utf8'));
    assert.equal(runDoc.cases[0].scores[0].passed, true);
    assert.equal(caseRecords(events, out)[0].scores[0].passed, true);
  });
});

describe('runner: unserializable task output', () => {
  it('a BigInt output degrades that payload, not the run', async () => {
    const file = writeEval('bigint_eval.ts', BIGINT_EVAL);
    const out = join(dir, 'runs');
    const events = await collect([file], { out_dir: out });
    const done = events.find((e) => e.type === 'evaluation_completed')!;
    assert.equal(done.counts.cases, 2); // the whole run survived
    const record = caseRecords(events, out)[0];
    assert.equal(record.output.unserializable, true);
    assert.equal(record.input, 1); // untouched payloads keep their real value
  });

  it('a reference cycle degrades that payload, not the run', async () => {
    const file = writeEval('cyclic_eval.ts', CYCLIC_EVAL);
    const out = join(dir, 'runs');
    const events = await collect([file], { out_dir: out });
    const done = events.find((e) => e.type === 'evaluation_completed')!;
    assert.equal(done.counts.cases, 2);
    assert.equal(caseRecords(events, out)[0].output.unserializable, true);
  });

  it('an unserializable payload survives truncation too', async () => {
    const file = writeEval('cyclic_eval.ts', CYCLIC_EVAL);
    const out = join(dir, 'runs');
    const events = await collect([file], { out_dir: out, max_payload_bytes: 16 });
    assert.equal(events.find((e) => e.type === 'evaluation_completed')!.counts.cases, 2);
  });
});

describe('runner: hook isolation', () => {
  it('a throwing event sink does not abort the run', async () => {
    const file = writeEval('two_eval.ts', TWO_CASE_EVAL);
    const events: Record<string, any>[] = [];
    await runSuite(
      [file],
      { no_artifact: true },
      new Emitter((ln) => {
        const event = JSON.parse(ln);
        if (event.type === 'case_started') throw new Error('EPIPE: event channel closed');
        events.push(event);
      }),
    );
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'case_completed').length, 2); // every case still ran
    assert.equal(types[types.length - 1], 'suite_completed');
  });

  it('a scorer producing a non-serializable score value still completes the run', async () => {
    // The runner's per-case hooks are isolated (parity with Python's @_isolated): shaping/emitting
    // a case must never abort the run. A BigInt score cannot be JSON-serialized, so it exercises
    // the reporting path's failure handling — every case must still finish.
    const file = writeEval(
      'bigint_score_eval.ts',
      `import { Dataset, Evaluation, scorer, FakeTransport } from '${EVAL_IMPORT}';
const weird = scorer((_ctx: any) => (1n as any), { name: 'weird', valueType: 'numeric', threshold: 0.5 });
const ds = new Dataset('d');
ds.add(1, { id: 'c0', expected: 1 });
ds.add(2, { id: 'c1', expected: 2 });
export const weirdEval = new Evaluation({ name: 'weird', dataset: ds, task: (x: any) => x, scorers: [weird], transport: new FakeTransport() });
`,
    );
    const events = await collect([file], { no_artifact: true });
    const types = events.map((e) => e.type);
    assert.equal(types[types.length - 1], 'suite_completed'); // finished, not aborted
  });
});

describe('runner: flush before exit', () => {
  it('main flushes pending spans after the last event', async () => {
    const file = writeEval('two_eval.ts', TWO_CASE_EVAL);
    const eventFile = join(dir, 'events.ndjson');
    process.env['TRACEROOT_EVAL_EVENT_FILE'] = eventFile;
    process.env['TRACEROOT_EVAL_OPTIONS'] = JSON.stringify({
      reporting: true,
      no_artifact: true,
    });
    const flushedAt: number[] = [];
    TraceRoot.flush = async () => {
      flushedAt.push(readFileSync(eventFile, 'utf8').trim().split('\n').length);
    };

    assert.equal(await main([file]), 0);

    const lines = readFileSync(eventFile, 'utf8').trim().split('\n');
    // Flushed exactly once, AFTER the last event — no span is left unbatched at hard exit.
    assert.deepEqual(flushedAt, [lines.length]);
    assert.equal(JSON.parse(lines[lines.length - 1]).type, 'suite_completed');
  });

  it('a failing flush never fails the run', async () => {
    const file = writeEval('two_eval.ts', TWO_CASE_EVAL);
    const eventFile = join(dir, 'events.ndjson');
    process.env['TRACEROOT_EVAL_EVENT_FILE'] = eventFile;
    process.env['TRACEROOT_EVAL_OPTIONS'] = JSON.stringify({
      reporting: true,
      no_artifact: true,
    });
    TraceRoot.flush = async () => {
      throw new Error('exporter unreachable');
    };

    assert.equal(await main([file]), 0);
    const lines = readFileSync(eventFile, 'utf8').trim().split('\n');
    assert.ok(!lines.some((l) => JSON.parse(l).type === 'fatal'));
  });
});

describe('runner: a payload whose serialization is not reproducible', () => {
  // The safety probe and the real serialization must be the SAME serialization. Probing with one
  // JSON.stringify and then writing the ORIGINAL value serializes it a second time — a payload
  // whose toJSON is not deterministic passes the probe and then throws while the artifact is
  // written, taking down a run whose cases had all already succeeded.
  it('keeps the first clean serialization instead of aborting the write', () => {
    let calls = 0;
    const flaky = {
      toJSON(): unknown {
        calls += 1;
        if (calls > 1) throw new Error('toJSON is not reproducible');
        return { ok: true };
      },
    };
    const result = makeRunResult(
      'r',
      [
        {
          caseId: 'c0',
          input: 1,
          output: flaky,
          expected: null,
          scores: [{ name: 'acc', value: 1, comment: null, metadata: null }],
          scorerErrors: {},
          error: null,
          traceId: null,
          durationMs: 1,
        },
      ],
      { status: 'skipped', dashboardUrl: null },
      { localRunId: 'lr_flaky' },
    );
    const casesPath = join(dir, 'lr_flaky.cases.jsonl');
    writeArtifacts(result, join(dir, 'lr_flaky.json'), casesPath, {
      status: 'completed',
      runMode: 'module',
      isFinal: true,
      sampleCount: null,
      sampleSeed: null,
      candidateVersion: null,
    });
    const record = JSON.parse(readFileSync(casesPath, 'utf8').trim());
    assert.deepEqual(record.output, { ok: true });
    assert.equal(calls, 1, 'the payload must be serialized exactly once');
  });
});
