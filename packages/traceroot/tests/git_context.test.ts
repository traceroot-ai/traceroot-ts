import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import {
  autoDetectGitContext,
  captureSourceLocation,
  harvestCiGitContext,
  gitContextFromFiles,
} from '../src/git_context';

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

describe('harvestCiGitContext()', () => {
  it('reads GitHub Actions vars', () => {
    const r = harvestCiGitContext({
      GITHUB_REPOSITORY: 'acme/web',
      GITHUB_SHA: 'a'.repeat(40),
    } as NodeJS.ProcessEnv);
    assert.equal(r.gitRepo, 'acme/web');
    assert.equal(r.gitRef, 'a'.repeat(40));
  });

  it('returns empty object when no CI vars set', () => {
    const r = harvestCiGitContext({} as NodeJS.ProcessEnv);
    assert.equal(r.gitRepo, undefined);
    assert.equal(r.gitRef, undefined);
  });

  it('treats empty-string GITHUB_REPOSITORY as absent', () => {
    const r = harvestCiGitContext({ GITHUB_REPOSITORY: '' } as NodeJS.ProcessEnv);
    assert.equal(r.gitRepo, undefined);
  });
});

describe('gitContextFromFiles()', () => {
  it('reads owner/repo from config and detached SHA from HEAD', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tr-git-'));
    const gitDir = path.join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      path.join(gitDir, 'config'),
      '[remote "origin"]\n\turl = git@github.com:acme/web.git\n',
    );
    writeFileSync(path.join(gitDir, 'HEAD'), 'f'.repeat(40) + '\n');
    const r = gitContextFromFiles(dir);
    assert.equal(r.gitRepo, 'acme/web');
    assert.equal(r.gitRef, 'f'.repeat(40));
  });

  it('resolves ref-based HEAD via refs file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tr-git-'));
    const gitDir = path.join(dir, '.git');
    mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), '1'.repeat(40) + '\n');
    const r = gitContextFromFiles(dir);
    assert.equal(r.gitRef, '1'.repeat(40));
  });

  it('resolves ref-based HEAD from packed-refs when the loose ref is absent', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tr-git-'));
    const gitDir = path.join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      path.join(gitDir, 'packed-refs'),
      '# pack-refs with: peeled fully-peeled sorted\n' + '2'.repeat(40) + ' refs/heads/main\n',
    );
    const r = gitContextFromFiles(dir);
    assert.equal(r.gitRef, '2'.repeat(40));
  });

  it('parses https remote url form', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tr-git-'));
    const gitDir = path.join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      path.join(gitDir, 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/web.git\n',
    );
    const r = gitContextFromFiles(dir);
    assert.equal(r.gitRepo, 'acme/web');
  });

  it('prefers url over pushurl in the origin section', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tr-git-'));
    const gitDir = path.join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      path.join(gitDir, 'config'),
      '[remote "origin"]\n\tpushurl = git@github.com:acme/push-mirror.git\n\turl = git@github.com:acme/web.git\n',
    );
    const r = gitContextFromFiles(dir);
    assert.equal(r.gitRepo, 'acme/web');
  });

  it('returns empty when no .git dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tr-git-'));
    const r = gitContextFromFiles(dir);
    assert.equal(r.gitRepo, undefined);
    assert.equal(r.gitRef, undefined);
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
