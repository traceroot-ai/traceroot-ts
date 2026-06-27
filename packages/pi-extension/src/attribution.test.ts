import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepoSlug, repoSlug, sessionAttributes, workspaceName } from './attribution.ts';

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'tr-attr-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result: void | Promise<void>;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
}

function initGitRepo(dir: string, remoteUrl?: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (remoteUrl) execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
}

// ---------------------------------------------------------------------------
// parseRepoSlug — remote-URL shapes
// ---------------------------------------------------------------------------

test('parseRepoSlug handles scp-like and https git remotes', () => {
  assert.equal(parseRepoSlug('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(parseRepoSlug('git@github.com:owner/repo'), 'owner/repo');
  assert.equal(parseRepoSlug('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(parseRepoSlug('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(parseRepoSlug('https://gitlab.com/group/sub/repo.git'), 'sub/repo');
});

test('parseRepoSlug handles trailing slashes, ssh:// urls, and surrounding whitespace', () => {
  assert.equal(parseRepoSlug('https://github.com/owner/repo/'), 'owner/repo');
  assert.equal(parseRepoSlug('  git@github.com:owner/repo.git\n'), 'owner/repo');
  assert.equal(parseRepoSlug('ssh://git@github.com/owner/repo.git'), 'owner/repo');
  assert.equal(parseRepoSlug('https://github.com/owner/repo.GIT'), 'owner/repo'); // case-insensitive .git
});

test('parseRepoSlug returns undefined for junk', () => {
  assert.equal(parseRepoSlug(''), undefined);
  assert.equal(parseRepoSlug('   '), undefined);
  assert.equal(parseRepoSlug('not a url'), undefined);
  assert.equal(parseRepoSlug('https://github.com/owner'), undefined); // only one segment
});

// ---------------------------------------------------------------------------
// repoSlug — asynchronous, cached, best-effort
// ---------------------------------------------------------------------------

test('repoSlug returns a Promise immediately and never blocks the caller', async () => {
  await withTempDir(async (dir) => {
    const result = repoSlug(dir);
    assert.ok(result instanceof Promise, 'repoSlug is async — it returns a promise, not a value');
    await result;
  });
});

test('repoSlug resolves the owner/repo slug for a real git remote', async () => {
  await withTempDir(async (dir) => {
    initGitRepo(dir, 'git@github.com:acme/widgets.git');
    assert.equal(await repoSlug(dir), 'acme/widgets');
  });
});

test('repoSlug resolves to undefined for a non-git directory (no throw, non-blocking)', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await repoSlug(dir), undefined);
  });
});

test('repoSlug resolves to undefined for a git repo with no origin remote', async () => {
  await withTempDir(async (dir) => {
    initGitRepo(dir); // no remote
    assert.equal(await repoSlug(dir), undefined);
  });
});

test('repoSlug caches per cwd: repeated calls share one git lookup', async () => {
  await withTempDir(async (dir) => {
    initGitRepo(dir, 'https://github.com/acme/cached.git');
    const a = repoSlug(dir);
    const b = repoSlug(dir);
    assert.strictEqual(a, b, 'the same promise instance is returned for a repeated cwd');
    assert.equal(await a, 'acme/cached');
  });
});

// ---------------------------------------------------------------------------
// sessionAttributes — synchronous attribution only
// ---------------------------------------------------------------------------

test('sessionAttributes returns only synchronous attribution, not the async repo slug', () => {
  const attrs = sessionAttributes('/a/b/my-project');
  assert.equal('traceroot.pi.repo' in attrs, false, 'repo is resolved asynchronously, not here');
  assert.equal(attrs['traceroot.pi.workspace'], 'my-project');
  assert.equal(attrs['traceroot.pi.os'], process.platform);
  assert.ok('traceroot.pi.hostname' in attrs);
  assert.ok('traceroot.pi.username' in attrs);
  assert.ok('traceroot.pi.extension_version' in attrs);
});

test('workspaceName is the cwd basename', () => {
  assert.equal(workspaceName('/a/b/my-project'), 'my-project');
});
