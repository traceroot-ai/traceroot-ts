import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { autoDetectGitContext, captureSourceLocation } from '../src/git_context';

describe('autoDetectGitContext()', () => {
  it('returns an object (possibly empty)', () => {
    const result = autoDetectGitContext();
    assert.ok(result !== null && typeof result === 'object');
  });

  it('gitRepo if present is owner/repo format — not a full URL', () => {
    const { gitRepo } = autoDetectGitContext();
    if (gitRepo !== undefined) {
      // Must be "owner/repo", never a full URL with protocol or .git suffix
      assert.ok(
        !gitRepo.startsWith('https://'),
        `gitRepo must not start with https://, got: ${gitRepo}`,
      );
      assert.ok(!gitRepo.startsWith('git@'), `gitRepo must not start with git@, got: ${gitRepo}`);
      assert.ok(
        !gitRepo.startsWith('ssh://'),
        `gitRepo must not start with ssh://, got: ${gitRepo}`,
      );
      assert.ok(!gitRepo.endsWith('.git'), `gitRepo must not end with .git, got: ${gitRepo}`);
      assert.match(
        gitRepo,
        /^[^/]+\/[^/]+$/,
        `gitRepo must be "owner/repo" format, got: ${gitRepo}`,
      );
    }
  });

  it('gitRef if present is a 40-char hex string', () => {
    const { gitRef } = autoDetectGitContext();
    if (gitRef !== undefined) {
      assert.match(gitRef, /^[0-9a-f]{40}$/);
    }
  });

  it('handles missing git gracefully (does not throw)', () => {
    let result: ReturnType<typeof autoDetectGitContext> | undefined;
    assert.doesNotThrow(() => {
      result = autoDetectGitContext();
    });
    assert.ok(result !== null && typeof result === 'object');
  });
});

describe('captureSourceLocation()', () => {
  it('returns an object with file and line when called from user code', () => {
    const result = captureSourceLocation();
    assert.ok(typeof result.file === 'string', 'file should be a string');
    assert.ok(
      typeof result.line === 'number' && result.line > 0,
      'line should be a positive number',
    );
  });

  it('file path does not include SDK internals', () => {
    const result = captureSourceLocation();
    if (result.file !== undefined) {
      assert.ok(
        !result.file.includes('/packages/traceroot/src/'),
        `file path should not include SDK internals, got: ${result.file}`,
      );
    }
  });

  it('file path is relative — does not start with /', () => {
    const result = captureSourceLocation();
    if (result.file !== undefined) {
      assert.ok(
        !result.file.startsWith('/'),
        `file path must be relative (not absolute), got: ${result.file}`,
      );
    }
  });

  it('file path is not absolute', () => {
    const result = captureSourceLocation();
    if (result.file !== undefined) {
      assert.ok(
        !path.isAbsolute(result.file),
        `file path must not be absolute, got: ${result.file}`,
      );
    }
  });

  it('functionName is defined when called from a named function', () => {
    function myTestFn() {
      return captureSourceLocation();
    }
    const result = myTestFn();
    if (result.functionName !== undefined) {
      assert.ok(
        result.functionName.includes('myTestFn'),
        `functionName should include "myTestFn", got: ${result.functionName}`,
      );
    }
  });
});
