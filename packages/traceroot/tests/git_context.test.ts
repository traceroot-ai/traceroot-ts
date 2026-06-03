import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  _normalizeRemoteRepoForTesting,
  _relativePathForTesting,
  autoDetectGitContext,
  captureSourceLocation,
  harvestCiGitContext,
} from '../src/git_context';

describe('harvestCiGitContext()', () => {
  it('resolves GitHub Actions env vars', () => {
    assert.deepEqual(
      harvestCiGitContext({
        GITHUB_REPOSITORY: 'acme/api',
        GITHUB_SHA: '1111111111111111111111111111111111111111',
      }),
      {
        gitRepo: 'acme/api',
        gitRef: '1111111111111111111111111111111111111111',
      },
    );
  });

  it('resolves Vercel env vars', () => {
    assert.deepEqual(
      harvestCiGitContext({
        VERCEL_GIT_REPO_OWNER: 'acme',
        VERCEL_GIT_REPO_SLUG: 'web',
        VERCEL_GIT_COMMIT_SHA: '2222222222222222222222222222222222222222',
      }),
      {
        gitRepo: 'acme/web',
        gitRef: '2222222222222222222222222222222222222222',
      },
    );
  });

  it('resolves GitLab CI env vars', () => {
    assert.deepEqual(
      harvestCiGitContext({
        CI_PROJECT_PATH: 'acme/worker',
        CI_COMMIT_SHA: '3333333333333333333333333333333333333333',
      }),
      {
        gitRepo: 'acme/worker',
        gitRef: '3333333333333333333333333333333333333333',
      },
    );
  });

  it('resolves CircleCI env vars', () => {
    assert.deepEqual(
      harvestCiGitContext({
        CIRCLE_PROJECT_USERNAME: 'acme',
        CIRCLE_PROJECT_REPONAME: 'jobs',
        CIRCLE_SHA1: '4444444444444444444444444444444444444444',
      }),
      {
        gitRepo: 'acme/jobs',
        gitRef: '4444444444444444444444444444444444444444',
      },
    );
  });

  it('resolves Bitbucket env vars', () => {
    assert.deepEqual(
      harvestCiGitContext({
        BITBUCKET_REPO_FULL_NAME: 'acme/data',
        BITBUCKET_COMMIT: '5555555555555555555555555555555555555555',
      }),
      {
        gitRepo: 'acme/data',
        gitRef: '5555555555555555555555555555555555555555',
      },
    );
  });

  it('resolves Render commit env var independently', () => {
    // Render exposes the commit SHA but not a standard owner/repo variable.
    assert.deepEqual(
      harvestCiGitContext({
        RENDER_GIT_COMMIT: '6666666666666666666666666666666666666666',
      }),
      {
        gitRef: '6666666666666666666666666666666666666666',
      },
    );
  });

  it('returns empty context for empty env', () => {
    assert.deepEqual(harvestCiGitContext({}), {});
  });

  it('uses first-platform-wins precedence per field', () => {
    // GitHub Actions appears before Vercel in the resolver ladder.
    assert.deepEqual(
      harvestCiGitContext({
        GITHUB_REPOSITORY: 'acme/github',
        GITHUB_SHA: '7777777777777777777777777777777777777777',
        VERCEL_GIT_REPO_OWNER: 'acme',
        VERCEL_GIT_REPO_SLUG: 'vercel',
        VERCEL_GIT_COMMIT_SHA: '8888888888888888888888888888888888888888',
      }),
      {
        gitRepo: 'acme/github',
        gitRef: '7777777777777777777777777777777777777777',
      },
    );
  });

  it('resolves repo and ref independently', () => {
    // Mixed env sources are valid when the first platform only provides one field.
    assert.deepEqual(
      harvestCiGitContext({
        GITHUB_REPOSITORY: 'acme/github',
        VERCEL_GIT_COMMIT_SHA: '9999999999999999999999999999999999999999',
      }),
      {
        gitRepo: 'acme/github',
        gitRef: '9999999999999999999999999999999999999999',
      },
    );
  });
});

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

describe('git remote normalization', () => {
  it('normalizes HTTPS git remotes', () => {
    assert.equal(_normalizeRemoteRepoForTesting('https://github.com/acme/api.git'), 'acme/api');
  });

  it('normalizes SSH git remotes', () => {
    assert.equal(_normalizeRemoteRepoForTesting('git@github.com:acme/api.git'), 'acme/api');
  });

  it('normalizes ssh:// git remotes', () => {
    assert.equal(_normalizeRemoteRepoForTesting('ssh://git@github.com/acme/api.git'), 'acme/api');
  });

  it('rejects local filesystem git remotes', () => {
    assert.equal(_normalizeRemoteRepoForTesting('/tmp/acme/api.git'), undefined);
  });

  it('rejects non-URL remote names', () => {
    assert.equal(_normalizeRemoteRepoForTesting('acme/api'), undefined);
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

describe('relative path handling', () => {
  it('does not treat a sibling path with the same prefix as inside the repo', () => {
    assert.equal(_relativePathForTesting('/tmp/repo-other/src/app.ts', '/tmp/repo'), undefined);
  });

  it('returns a relative path when the file is inside the repo', () => {
    assert.equal(_relativePathForTesting('/tmp/repo/src/app.ts', '/tmp/repo'), 'src/app.ts');
  });

  it('does not treat a Windows sibling path with the same prefix as inside the repo', () => {
    assert.equal(
      _relativePathForTesting('C:\\work\\repo-other\\src\\app.ts', 'C:\\work\\repo'),
      undefined,
    );
  });

  it('returns a slash-normalized relative path for Windows repo files', () => {
    assert.equal(
      _relativePathForTesting('C:\\work\\repo\\src\\app.ts', 'C:\\work\\repo'),
      'src/app.ts',
    );
  });
});
