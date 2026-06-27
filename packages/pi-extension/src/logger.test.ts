import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLogger } from './logger.ts';

test('a logger with no path is a no-op and never throws', () => {
  const logger = createFileLogger(undefined);
  logger.log('debug', 'ignored'); // must not throw
});

test('createFileLogger writes the debug log owner-only and creates the directory', () => {
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
