// Ctrl+C reaching the runner while a case is stalled, driven the way traceroot-cli drives it: the
// runner entry under tsx, in a process group of its own, with SIGINT sent to that group and the
// group killed if it is still alive ten seconds later (the CLI's grace period).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNNER = join(__dirname, '..', 'src', 'eval', 'runner.ts');
const TSX = pathToFileURL(require.resolve('tsx')).href;
const SDK = join(__dirname, '..', 'src', 'eval').replace(/\\/g, '/');
const GRACE_MS = 10_000;

// 'stalled' waits a minute for a reply, as a stream that sent one chunk and went silent does.
const EVAL_SRC = `
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

describe('Ctrl+C while a case is stalled', () => {
  it(
    'saves the completed cases as an incomplete run and exits 130',
    { timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'runner-cancel-'));
      const evalFile = join(dir, 'stall.eval.ts');
      const eventFile = join(dir, 'events.jsonl');
      writeFileSync(evalFile, EVAL_SRC);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(TRACEROOT_|OTEL_)/.test(key)),
      );
      // What the CLI sets for a run that stays on this machine.
      Object.assign(env, {
        TRACEROOT_ENABLED: 'false',
        TRACEROOT_EVAL_OPTIONS: '{}',
        TRACEROOT_EVAL_EVENT_FILE: eventFile,
      });
      const child = spawn(process.execPath, ['--import', TSX, RUNNER, evalFile], {
        cwd: dir,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.on('exit', (code, signal) => resolve({ code, signal })),
      );
      const group = child.pid!;
      let killed = false;
      try {
        // Wait for three completed cases and the stalled one running.
        const startedBy = Date.now() + 30_000;
        for (;;) {
          const events = readEvents(eventFile);
          const done = events.filter((e) => e.type === 'case_completed').length;
          const stalled = events.some((e) => e.type === 'case_started' && e.case_id === 'stalled');
          if (done === 3 && stalled) break;
          assert.ok(Date.now() < startedBy, `the runner never got to the stalled case:\n${output}`);
          await sleep(50);
        }

        process.kill(-group, 'SIGINT');
        const exit = await Promise.race([exited, sleep(GRACE_MS).then(() => null)]);
        if (exit === null) {
          killed = true;
          process.kill(-group, 'SIGKILL');
        }
        const { code, signal } = await exited;

        assert.equal(killed, false, `the runner was still running ${GRACE_MS} ms after SIGINT`);
        assert.deepEqual({ code, signal }, { code: 130, signal: null }, output);

        const events = readEvents(eventFile);
        const last = events[events.length - 1];
        assert.deepEqual(last, { type: 'suite_completed', evaluations: 1, cancelled: true });
        const completed = events.find((e) => e.type === 'evaluation_completed');
        assert.ok(completed?.artifact, 'no saved run');
        assert.equal(completed.status, 'incomplete');
        assert.equal(completed.counts?.cases, 3);
        assert.ok(
          !events.some((e) => e.type === 'case_completed' && e.case_id === 'stalled'),
          'the stalled case was reported as completed',
        );

        const runFile = join(dir, completed.artifact.run);
        const casesFile = join(dir, completed.artifact.cases);
        const run = JSON.parse(readFileSync(runFile, 'utf8'));
        assert.equal(run.status, 'incomplete');
        assert.equal(run.is_final, false);
        assert.deepEqual(run.cases.map((c: Event) => c.case_id).sort(), ['a', 'b', 'c']);
        const cases = readFileSync(casesFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.deepEqual(cases.map((c: Event) => c.case_id).sort(), ['a', 'b', 'c']);
      } finally {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          // Already gone.
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
