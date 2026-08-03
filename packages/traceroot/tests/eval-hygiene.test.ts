// Artifact hygiene — dir perms, .gitignore, bounded payloads, and a proof that
// credentials never land in a written artifact.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

import { writeArtifacts, makeRunResult } from '../src/eval';
import type { EvalItemResult, EvalRunResult } from '../src/eval';

const SENTINEL_KEY = 'tr-SECRET-should-never-persist-abc123';
let prevKey: string | undefined;
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tr-eval-hyg-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  if (prevKey === undefined) delete process.env['TRACEROOT_API_KEY'];
  else process.env['TRACEROOT_API_KEY'] = prevKey;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function item(caseId: string, input: unknown, output: unknown): EvalItemResult {
  return {
    caseId,
    input,
    output,
    expected: output,
    scores: [{ name: 'acc', value: 1, comment: null, metadata: null }],
    scorerErrors: {},
    error: null,
    traceId: null,
    durationMs: 1,
  };
}

function run(items: EvalItemResult[]): EvalRunResult {
  return makeRunResult(
    'r',
    items,
    { status: 'uploaded', dashboardUrl: null },
    { localRunId: 'lr_test', candidateVersion: 'v1' },
  );
}

const opts = {
  status: 'completed',
  runMode: 'module',
  isFinal: true,
  sampleCount: null,
  sampleSeed: null,
  candidateVersion: 'v1',
  provenance: null,
};

describe('artifact hygiene', () => {
  it('credentials in the environment never appear in written artifacts', () => {
    prevKey = process.env['TRACEROOT_API_KEY'];
    process.env['TRACEROOT_API_KEY'] = SENTINEL_KEY;
    const dir = tmp();
    const runPath = join(dir, 'lr.json');
    const casesPath = join(dir, 'lr.cases.jsonl');
    writeArtifacts(run([item('c0', { q: 'hi' }, { a: 'ok' })]), runPath, casesPath, opts);

    const runDoc = readFileSync(runPath, 'utf8');
    const cases = readFileSync(casesPath, 'utf8');
    assert.equal(runDoc.includes(SENTINEL_KEY), false, 'run.json must not contain the api key');
    assert.equal(cases.includes(SENTINEL_KEY), false, 'cases.jsonl must not contain the api key');
  });

  it('writes a .gitignore that ignores everything in the artifact dir', () => {
    const dir = tmp();
    writeArtifacts(
      run([item('c0', 1, 1)]),
      join(dir, 'lr.json'),
      join(dir, 'lr.cases.jsonl'),
      opts,
    );
    const gi = join(dir, '.gitignore');
    assert.ok(existsSync(gi));
    assert.match(readFileSync(gi, 'utf8'), /^\*$/m);
  });

  it('restricts artifact file and directory permissions (POSIX)', () => {
    if (platform() === 'win32') return; // no POSIX modes
    // A fresh subdir writeArtifacts must create itself (mkdtemp would already be 0700, making the
    // dir assertion tautological); this way we actually exercise its chmod + file mode.
    const dir = join(tmp(), 'runs');
    const runPath = join(dir, 'lr.json');
    writeArtifacts(run([item('c0', 1, 1)]), runPath, join(dir, 'lr.cases.jsonl'), opts);
    assert.equal(statSync(dir).mode & 0o777, 0o700); // dir locked down by writeArtifacts
    assert.equal(statSync(runPath).mode & 0o777, 0o600); // artifact file is owner-only
  });

  it('bounds payloads when maxPayloadBytes is set (marker, not silent drop)', () => {
    const dir = tmp();
    const big = 'x'.repeat(5000);
    const artifact = writeArtifacts(
      run([item('c0', { blob: big }, { blob: big })]),
      join(dir, 'lr.json'),
      join(dir, 'lr.cases.jsonl'),
      { ...opts, maxPayloadBytes: 64 },
    );
    assert.equal(artifact.payloads, 'truncated');
    const cases = JSON.parse(readFileSync(join(dir, 'lr.cases.jsonl'), 'utf8').trim());
    assert.equal(cases.input.truncated, true);
    assert.ok(typeof cases.input.preview === 'string');
    assert.ok(cases.input.preview.length <= 64);
  });

  it('leaves payloads complete by default (no truncation)', () => {
    const dir = tmp();
    const artifact = writeArtifacts(
      run([item('c0', { blob: 'x'.repeat(5000) }, 1)]),
      join(dir, 'lr.json'),
      join(dir, 'lr.cases.jsonl'),
      opts,
    );
    assert.equal(artifact.payloads, 'complete');
  });
});
