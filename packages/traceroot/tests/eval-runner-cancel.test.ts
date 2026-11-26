// Ctrl+C reaching the runner while a case is stalled, driven the way traceroot-cli drives it: the
// runner entry under tsx, in a process group of its own, with SIGINT sent to that group and the
// group killed if it is still alive ten seconds later (the CLI's grace period).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CANCEL_SAVE_MS } from '../src/eval/engine';

const RUNNER = join(__dirname, '..', 'src', 'eval', 'runner.ts');
const TSX = pathToFileURL(require.resolve('tsx')).href;
const SDK = join(__dirname, '..', 'src', 'eval').replace(/\\/g, '/');
const GRACE_MS = 10_000;

// 'stalled' waits a minute for a reply, as a stream that sent one chunk and went silent does.
const STALLED_SRC = `
import { Dataset, Evaluation } from '${SDK}';
const data = new Dataset('stall');
for (const id of ['a', 'b', 'c', 'stalled']) data.add({ id }, { id, expected: id });
async function task(input: { id: string }) {
  if (input.id === 'stalled') await new Promise((resolve) => setTimeout(resolve, 60_000));
  return input.id;
}
function scored() { return 1; }
export const stall = new Evaluation({ name: 'stall', dataset: data, task, scorers: [scored], maxConcurrency: 4 });
`;

// Every case completes at once; TraceRoot is slow to acknowledge 'slow' (see fakeTraceRoot).
const UPLOADED_SRC = `
import { Dataset, Evaluation } from '${SDK}';
const data = new Dataset('slow-ack');
for (const id of ['a', 'b', 'c', 'slow']) data.add({ id }, { id, expected: id });
function task(input: { id: string }) { return input.id; }
function scored() { return 1; }
export const slowAck = new Evaluation({ name: 'slow-ack', dataset: data, task, scorers: [scored], maxConcurrency: 4 });
`;

/** The fields of the runner's events and saved cases this test reads. */
interface Event {
  type?: string;
  case_id?: string;
  status?: string;
  counts?: { cases: number };
  artifact?: { run: string; cases: string };
}

function readEvents(path: string): Event[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Runner {
  dir: string;
  eventFile: string;
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts the runner on `source` in a process group of its own, with the CLI's `variables`. */
function startRunner(source: string, variables: Record<string, string>): Runner {
  const dir = mkdtempSync(join(tmpdir(), 'runner-cancel-'));
  const evalFile = join(dir, 'case.eval.ts');
  const eventFile = join(dir, 'events.jsonl');
  writeFileSync(evalFile, source);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(TRACEROOT_|OTEL_)/.test(key)),
  );
  Object.assign(env, variables, { TRACEROOT_EVAL_EVENT_FILE: eventFile });
  const child = spawn(process.execPath, ['--import', TSX, RUNNER, evalFile], {
    cwd: dir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  return { dir, eventFile, child, output: () => output, exited };
}

async function waitUntil(runner: Runner, ready: (events: Event[]) => boolean): Promise<void> {
  const by = Date.now() + 30_000;
  while (!ready(readEvents(runner.eventFile))) {
    assert.ok(Date.now() < by, `the runner never got there:\n${runner.output()}`);
    await sleep(50);
  }
}

/** SIGINT to the group, then SIGKILL if it outlives the CLI's grace period. */
async function interrupt(runner: Runner) {
  process.kill(-runner.child.pid!, 'SIGINT');
  const exit = await Promise.race([runner.exited, sleep(GRACE_MS).then(() => null)]);
  if (exit === null) process.kill(-runner.child.pid!, 'SIGKILL');
  return { killed: exit === null, ...(await runner.exited) };
}

function stop(runner: Runner): void {
  try {
    process.kill(-runner.child.pid!, 'SIGKILL');
  } catch {
    // Already gone.
  }
  rmSync(runner.dir, { recursive: true, force: true });
}

/** The run's terminal events and the run file and cases file it saved. */
function saved(runner: Runner) {
  const events = readEvents(runner.eventFile);
  const completed = events.find((e) => e.type === 'evaluation_completed');
  assert.ok(completed?.artifact, `no saved run:\n${runner.output()}`);
  const runFile = join(runner.dir, completed.artifact.run);
  const casesFile = join(runner.dir, completed.artifact.cases);
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  const cases = readFileSync(casesFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return {
    events,
    completed,
    last: events[events.length - 1],
    run,
    runIds: run.cases.map((c: Event) => c.case_id).sort(),
    caseIds: cases.map((c: Event) => c.case_id).sort(),
    writtenAt: Math.max(statSync(runFile).mtimeMs, statSync(casesFile).mtimeMs),
  };
}

/**
 * A TraceRoot host with just the endpoints an uploaded run calls. It saves every case result as it
 * arrives, but holds its reply to `heldCase`'s for `holdMs`. With `silentClose` it takes the
 * request closing the run and never answers it.
 */
async function fakeTraceRoot(
  options: { heldCase?: string; holdMs?: number; silentClose?: boolean } = {},
) {
  const { heldCase, holdMs = 0, silentClose = false } = options;
  const results: string[] = [];
  let completedAs: string | null = null;
  let arrived!: () => void;
  const heldArrived = new Promise<void>((resolve) => (arrived = resolve));
  const timers: NodeJS.Timeout[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && /\/public\/datasets\/[^/]+$/.test(url))
        return reply(404, { detail: 'not found' });
      if (url.endsWith('/versions'))
        return reply(200, { dataset_version_id: 'dsv_1', version_number: 1 });
      if (url.endsWith('/public/evaluation-runs'))
        return reply(200, { evaluation_run_id: 'run_1' });
      if (url.endsWith('/results')) {
        const caseId = JSON.parse(body).test_case_id;
        results.push(caseId);
        if (caseId !== heldCase) return reply(200, {});
        arrived();
        timers.push(setTimeout(() => reply(200, {}), holdMs));
        return;
      }
      if (url.endsWith('/complete')) {
        completedAs = JSON.parse(body).status;
        if (silentClose) return;
      }
      // Dataset metadata, completion, span export.
      return reply(200, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    results,
    completedAs: () => completedAs,
    heldArrived,
    close: () => {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      server.close();
    },
  };
}

describe('Ctrl+C while a case is stalled', () => {
  it(
    'saves the completed cases as an incomplete run and exits 130',
    { timeout: 60_000 },
    async () => {
      // What the CLI sets for a run that stays on this machine.
      const runner = startRunner(STALLED_SRC, {
        TRACEROOT_ENABLED: 'false',
        TRACEROOT_EVAL_OPTIONS: '{}',
      });
      try {
        // Three completed cases and the stalled one running.
        await waitUntil(
          runner,
          (events) =>
            events.filter((e) => e.type === 'case_completed').length === 3 &&
            events.some((e) => e.type === 'case_started' && e.case_id === 'stalled'),
        );

        const { killed, code, signal } = await interrupt(runner);
        assert.equal(killed, false, `the runner was still running ${GRACE_MS} ms after SIGINT`);
        assert.deepEqual({ code, signal }, { code: 130, signal: null }, runner.output());

        const { events, completed, last, run, runIds, caseIds } = saved(runner);
        assert.deepEqual(last, { type: 'suite_completed', evaluations: 1, cancelled: true });
        assert.equal(completed.status, 'incomplete');
        assert.equal(completed.counts?.cases, 3);
        assert.ok(
          !events.some((e) => e.type === 'case_completed' && e.case_id === 'stalled'),
          'the stalled case was reported as completed',
        );
        assert.equal(run.status, 'incomplete');
        assert.equal(run.is_final, false);
        assert.deepEqual(runIds, ['a', 'b', 'c']);
        assert.deepEqual(caseIds, ['a', 'b', 'c']);
      } finally {
        stop(runner);
      }
    },
  );

  it(
    'keeps an uploaded result TraceRoot saved but had not acknowledged, counted as unconfirmed',
    { timeout: 60_000 },
    async () => {
      // TraceRoot saves 'slow' at once but replies 8 s later: past the 5 s drain, inside the 10 s.
      const host = await fakeTraceRoot({ heldCase: 'slow', holdMs: 8_000 });
      // What the CLI sets for an uploaded run.
      const runner = startRunner(UPLOADED_SRC, {
        TRACEROOT_API_KEY: 'tr-test-key',
        TRACEROOT_HOST_URL: host.url,
        TRACEROOT_ENABLED: 'true',
        TRACEROOT_EVAL_OPTIONS: JSON.stringify({ reporting: true }),
      });
      try {
        await host.heldArrived;
        await waitUntil(
          runner,
          (events) => events.filter((e) => e.type === 'case_completed').length === 3,
        );

        const { killed, code, signal } = await interrupt(runner);
        assert.equal(killed, false, `the runner was still running ${GRACE_MS} ms after SIGINT`);
        assert.deepEqual({ code, signal }, { code: 130, signal: null }, runner.output());

        const { events, completed, last, run, runIds, caseIds } = saved(runner);
        assert.deepEqual(last, { type: 'suite_completed', evaluations: 1, cancelled: true });
        assert.equal(completed.status, 'incomplete');
        assert.equal(completed.counts?.cases, 4);
        const slow = events.filter((e) => e.type === 'case_completed' && e.case_id === 'slow');
        assert.equal(slow.length, 1);
        assert.equal(run.status, 'incomplete');
        assert.deepEqual(runIds, ['a', 'b', 'c', 'slow']);
        assert.deepEqual(caseIds, ['a', 'b', 'c', 'slow']);
        assert.equal(run.upload.unconfirmed_result_count, 1);
        assert.equal(run.upload.failed_result_count, 0);
        assert.equal(run.upload.close_confirmed, true);
        // TraceRoot has the same four, and the run closed incomplete.
        assert.deepEqual([...host.results].sort(), ['a', 'b', 'c', 'slow']);
        assert.equal(host.completedAs(), 'incomplete');
      } finally {
        stop(runner);
        host.close();
      }
    },
  );
});

describe('Ctrl+C while TraceRoot never answers closing the run', () => {
  it(
    'saves the completed cases within the save budget, with the close unconfirmed, and exits 130',
    { timeout: 60_000 },
    async () => {
      const host = await fakeTraceRoot({ silentClose: true });
      const runner = startRunner(STALLED_SRC, {
        TRACEROOT_API_KEY: 'tr-test-key',
        TRACEROOT_HOST_URL: host.url,
        TRACEROOT_ENABLED: 'true',
        TRACEROOT_EVAL_OPTIONS: JSON.stringify({ reporting: true }),
      });
      try {
        await waitUntil(
          runner,
          (events) =>
            events.filter((e) => e.type === 'case_completed').length === 3 &&
            events.some((e) => e.type === 'case_started' && e.case_id === 'stalled'),
        );

        const signalledAt = Date.now();
        const { killed, code, signal } = await interrupt(runner);
        assert.equal(killed, false, `the runner was still running ${GRACE_MS} ms after SIGINT`);
        assert.deepEqual({ code, signal }, { code: 130, signal: null }, runner.output());

        const { completed, last, run, runIds, caseIds, writtenAt } = saved(runner);
        // The budget counts from when the runner sees the signal; allow for delivery and the writes.
        const after = writtenAt - signalledAt;
        assert.ok(after < CANCEL_SAVE_MS + 1_000, `the run was saved ${after} ms after the signal`);
        assert.deepEqual(last, { type: 'suite_completed', evaluations: 1, cancelled: true });
        assert.equal(completed.status, 'incomplete');
        assert.equal(run.status, 'incomplete');
        assert.deepEqual(runIds, ['a', 'b', 'c']);
        assert.deepEqual(caseIds, ['a', 'b', 'c']);
        assert.equal(run.upload.close_confirmed, false);
        assert.equal(run.upload.unconfirmed_result_count, 0);
        assert.equal(run.upload.failed_result_count, 0);
        // TraceRoot got the request closing the run as incomplete; it just never answered.
        assert.equal(host.completedAs(), 'incomplete');
        assert.deepEqual([...host.results].sort(), ['a', 'b', 'c']);
      } finally {
        stop(runner);
        host.close();
      }
    },
  );
});
