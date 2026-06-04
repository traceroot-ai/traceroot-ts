// src/git_context.ts
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GITHUB_REPOSITORY, GITHUB_SHA } from './constants';

const REPO_URL_RE = /(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/](.+?)(?:\.git)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;

let _gitRootCache: string | null = null; // null = not yet detected, '' = failed

export function getGitRoot(): string | undefined {
  if (_gitRootCache !== null) return _gitRootCache || undefined;
  try {
    _gitRootCache = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    _gitRootCache = '';
  }
  return _gitRootCache || undefined;
}

function relativePath(filepath: string): string | undefined {
  const gitRoot = getGitRoot();
  if (gitRoot && filepath.startsWith(gitRoot)) {
    return filepath.slice(gitRoot.length).replace(/^[/\\]/, '');
  }
  // If we can't make the path relative, don't stamp it — avoid leaking absolute paths.
  return undefined;
}

/**
 * Read git context directly from `.git` files (no `git` subprocess).
 * Works in containers that ship a `.git` dir but no `git` binary.
 * Only inspects `<cwd>/.git` (does not walk parent directories).
 */
export function gitContextFromFiles(cwd: string = process.cwd()): {
  gitRepo?: string;
  gitRef?: string;
} {
  const gitDir = join(cwd, '.git');
  let gitRepo: string | undefined;
  let gitRef: string | undefined;

  try {
    const config = readFileSync(join(gitDir, 'config'), 'utf8');
    let seenOrigin = false;
    for (const line of config.split(/\r?\n/)) {
      if (/^\[remote "origin"\]/.test(line)) {
        seenOrigin = true;
        continue;
      }
      if (seenOrigin && line.startsWith('[')) break; // left the origin section
      if (seenOrigin) {
        const m = line.match(/\burl\s*=\s*(.+)$/);
        if (m) {
          const rm = m[1].trim().match(REPO_URL_RE);
          if (rm) gitRepo = rm[1].replace(/\/$/, '');
          break;
        }
      }
    }
  } catch {
    /* no .git/config */
  }

  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (SHA_RE.test(head)) {
      gitRef = head;
    } else {
      const rm = head.match(/ref:\s+(\S+)/);
      if (rm) {
        const refContent = readFileSync(join(gitDir, rm[1]), 'utf8').trim();
        if (SHA_RE.test(refContent)) gitRef = refContent;
      }
    }
  } catch {
    /* no .git/HEAD */
  }

  return { gitRepo, gitRef };
}

/**
 * Auto-detects git repo (as "owner/repo") and current commit ref.
 * Returns an empty object if git is unavailable or any command fails.
 */
export function autoDetectGitContext(): { gitRepo?: string; gitRef?: string } {
  let gitRepo: string | undefined;
  let gitRef: string | undefined;

  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Normalize to "owner/repo" — handles https, git@, ssh:// formats
    const match = remote.match(REPO_URL_RE);
    if (match) {
      gitRepo = match[1].replace(/\/$/, '');
    }
  } catch {
    /* git unavailable */
  }

  try {
    gitRef =
      execSync('git rev-parse HEAD', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || undefined;
  } catch {
    /* git unavailable */
  }

  // Warm the git root cache now so the first observe() call doesn't shell out.
  getGitRoot();

  return { gitRepo, gitRef };
}

/**
 * Resolve git context from GitHub Actions environment variables —
 * `GITHUB_REPOSITORY` (owner/repo) and `GITHUB_SHA`.
 *
 * repo and ref are resolved independently (a build may provide one, not both).
 */
export function harvestCiGitContext(
  env: NodeJS.ProcessEnv = process.env,
): { gitRepo?: string; gitRef?: string } {
  return {
    gitRepo: env[GITHUB_REPOSITORY] || undefined,
    gitRef: env[GITHUB_SHA] || undefined,
  };
}

/** @internal — reset cached git root between tests */
export function _resetGitContextCache(): void {
  _gitRootCache = null;
}

/**
 * Captures the call-site source location by inspecting the JS call stack.
 * Skips SDK-internal frames and node_modules. Returns path relative to git root.
 */
export function captureSourceLocation(): { file?: string; line?: number; functionName?: string } {
  const stack = new Error().stack;
  if (!stack) return {};

  const lines = stack.split('\n').slice(1); // remove "Error" header line
  for (const line of lines) {
    if (line.includes('/packages/traceroot/src/')) continue;
    if (line.includes('/node_modules/')) continue;
    if (line.includes('(node:')) continue; // skip Node.js built-in frames (e.g. node:internal/async_local_storage)

    // Parse "    at functionName (file:line:col)" or "    at file:line:col"
    const match = line.match(/^\s+at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/);
    if (!match) continue;

    const [, fnName, file, lineStr] = match;
    return {
      file: relativePath(file),
      line: parseInt(lineStr, 10),
      functionName: fnName || undefined,
    };
  }
  return {};
}
