import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistSessionTrace, readSessionTrace } from './fork-link.ts';

const VALID = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fork-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('persist + read round-trips a valid trace', () => {
  withTempDir((dir) => {
    const sessionFile = '/some/dir/session-abc.jsonl';
    persistSessionTrace(dir, sessionFile, VALID);
    assert.deepEqual(readSessionTrace(dir, sessionFile), VALID);
  });
});

test('rejects ids that are not well-formed hex SpanContext ids', () => {
  withTempDir((dir) => {
    const sf = '/d/session-bad.jsonl';
    persistSessionTrace(dir, sf, { traceId: 'xyz', spanId: VALID.spanId }); // non-hex / short
    assert.equal(readSessionTrace(dir, sf), null);
    persistSessionTrace(dir, sf, { traceId: VALID.traceId, spanId: 'tooShort' });
    assert.equal(readSessionTrace(dir, sf), null);
    persistSessionTrace(dir, sf, { traceId: 'A'.repeat(32), spanId: VALID.spanId }); // uppercase
    assert.equal(readSessionTrace(dir, sf), null);
  });
});

test('returns null when no persisted file exists', () => {
  withTempDir((dir) => {
    assert.equal(readSessionTrace(dir, '/d/missing.jsonl'), null);
  });
});

test('same basename in different directories does not cross-link (keyed by full path)', () => {
  withTempDir((dir) => {
    const a = '/projects/alpha/session.jsonl';
    const b = '/projects/beta/session.jsonl'; // same basename, different directory
    const traceA = { traceId: 'a'.repeat(32), spanId: 'a'.repeat(16) };
    const traceB = { traceId: 'b'.repeat(32), spanId: 'b'.repeat(16) };
    persistSessionTrace(dir, a, traceA);
    persistSessionTrace(dir, b, traceB);
    assert.deepEqual(readSessionTrace(dir, a), traceA, 'session a keeps its own trace');
    assert.deepEqual(readSessionTrace(dir, b), traceB, 'session b is not overwritten by a');
  });
});

test('a null session file is a no-op, not an error', () => {
  withTempDir((dir) => {
    persistSessionTrace(dir, null, VALID);
    assert.equal(readSessionTrace(dir, null), null);
  });
});
