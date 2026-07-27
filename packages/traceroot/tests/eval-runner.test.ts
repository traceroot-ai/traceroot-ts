// Parity: the runner — discovery, handshake, event stream, artifacts, list mode, filter.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Emitter, runSuite } from '../src/eval';

const EVAL_SRC = `
import { Dataset, Evaluation, FakeTransport } from '${join(__dirname, '..', 'src', 'eval').replace(/\\/g, '/')}';
const ds = new Dataset('tickets');
ds.add({ m: 'charge' }, { id: 'a', expected: { r: 'billing' } });
ds.add({ m: 'hello' }, { id: 'b', expected: { r: 'general' } });
function route(x: any) { return { r: x.m === 'charge' ? 'billing' : 'general' }; }
function accuracy(ctx: any) { return JSON.stringify(ctx.output) === JSON.stringify(ctx.expected) ? 1 : 0; }
// Cloud-only: a run reports through a transport. This eval configures a non-network
// FakeTransport (a real eval would report to the platform with credentials).
export const routing = new Evaluation({ name: 'ticket-routing', dataset: ds, task: route, scorers: [accuracy], transport: new FakeTransport() });
`;

let dir: string;
let evalFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-'));
  evalFile = join(dir, 'routing_eval.ts');
  writeFileSync(evalFile, EVAL_SRC);
});
afterEach(() => {
  delete process.env['TRACEROOT_ENABLED'];
});

function collect(
  paths: string[],
  options: Record<string, unknown>,
): Promise<Record<string, any>[]> {
  const events: Record<string, any>[] = [];
  return runSuite(paths, options, new Emitter((ln) => events.push(JSON.parse(ln)))).then(
    () => events,
  );
}

describe('runner', () => {
  it('list mode: hello + definitions, no run', async () => {
    const events = await collect([evalFile], { mode: 'list', reporting: true });
    assert.equal(events[0].type, 'hello');
    assert.equal(events[0].eval_api_version, 1);
    assert.equal(events[0].capabilities.cancellation, true);
    const defs = events.find((e) => e.type === 'definitions');
    assert.equal(defs.evaluations[0].name, 'ticket-routing');
  });

  it('full run: hello -> started -> case_completed x2 -> completed -> suite_completed', async () => {
    const events = await collect([evalFile], { reporting: true, no_artifact: true });
    const types = events.map((e) => e.type);
    assert.equal(types[0], 'hello');
    assert.ok(types.includes('evaluation_started'));
    assert.equal(types.filter((t) => t === 'case_completed').length, 2);
    const done = events.find((e) => e.type === 'evaluation_completed');
    assert.equal(done.status, 'completed');
    assert.equal(done.counts.passed, 2);
    assert.ok(done.local_run_id.startsWith('run_'));
    assert.equal(types[types.length - 1], 'suite_completed');
  });

  it('writes the two-file artifact with run.json + cases.jsonl', async () => {
    const out = join(dir, 'runs');
    const events = await collect([evalFile], { reporting: true, out_dir: out });
    const done = events.find((e) => e.type === 'evaluation_completed');
    const runPath = done.artifact.run as string;
    const casesPath = done.artifact.cases as string;
    assert.ok(existsSync(runPath) && runPath.endsWith('.json'));
    assert.ok(existsSync(casesPath) && casesPath.endsWith('.cases.jsonl'));
    const runDoc = JSON.parse(readFileSync(runPath, 'utf8'));
    assert.equal(runDoc.kind, 'eval_run');
    assert.equal(runDoc.counts.cases, 2);
    assert.ok(!('input' in runDoc.cases[0])); // run.json carries metadata, not payloads
    const lines = readFileSync(casesPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.ok('input' in lines[0]); // full payloads in the sidecar
  });

  it('filter selects by evaluation name', async () => {
    const events = await collect([evalFile], { filter: ['nope'], mode: 'list', reporting: true });
    assert.equal(events.find((e) => e.type === 'definitions').evaluations.length, 0);
  });
});
