import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLogger } from './logger.ts';

test('a logger with no path is a no-op and never throws', () => {
  const logger = createFileLogger(undefined);
  logger.log('debug', 'ignored'); // must not throw
});

test('createFileLogger writes a NEW debug log owner-only and creates the directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-log-'));
  try {
    const file = join(dir, 'sub', 'debug.log');
    const logger = createFileLogger(file);
    logger.log('debug', 'hello', { a: 1 });
    const mode = statSync(file).mode & 0o777;
    assert.equal(
      mode & 0o077,
      0,
      `debug log must not be group/world accessible (mode=${mode.toString(8)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createFileLogger tightens permissions on a PRE-EXISTING world-readable log file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-log-'));
  try {
    const file = join(dir, 'debug.log');
    writeFileSync(file, 'old line\n');
    chmodSync(file, 0o644); // simulate a pre-existing group/world-readable log
    assert.notEqual(statSync(file).mode & 0o077, 0, 'precondition: file starts broadly readable');
    const logger = createFileLogger(file);
    logger.log('debug', 'new line');
    const mode = statSync(file).mode & 0o777;
    assert.equal(
      mode & 0o077,
      0,
      `a pre-existing log must be tightened to owner-only (mode=${mode.toString(8)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
