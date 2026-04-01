// src/git_context.ts
import { execSync } from 'node:child_process';

let _gitRootCache: string | null = null; // null = not yet detected, '' = failed

function getGitRoot(): string | undefined {
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

function relativePath(filepath: string): string {
  const gitRoot = getGitRoot();
  if (gitRoot && filepath.startsWith(gitRoot)) {
    return filepath.slice(gitRoot.length).replace(/^[/\\]/, '');
  }
  return filepath;
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
    const match = remote.match(
      /(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/](.+?)(?:\.git)?$/,
    );
    if (match) {
      gitRepo = match[1].replace(/\/$/, '');
    }
  } catch { /* git unavailable */ }

  try {
    gitRef = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || undefined;
  } catch { /* git unavailable */ }

  // Warm the git root cache now so the first observe() call doesn't shell out.
  getGitRoot();

  return { gitRepo, gitRef };
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
