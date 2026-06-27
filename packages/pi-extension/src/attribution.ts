// Source attribution for the session span: machine, user, OS, workspace, and the
// git repo slug (derived from the origin remote). All best-effort — a failure
// yields undefined and the attribute is simply omitted, never an error.
import { execFile } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { basename } from 'node:path';
import { EXTENSION_VERSION } from './version.ts';

const GIT_TIMEOUT_MS = 500;
// Cache the in-flight/resolved promise per cwd, so the git lookup runs at most once per
// directory and concurrent callers share the same result.
const repoSlugCache = new Map<string, Promise<string | undefined>>();

export function hostName(): string | undefined {
  try {
    return hostname() || undefined;
  } catch {
    return undefined;
  }
}

export function userName(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return process.env.USER || process.env.USERNAME || undefined;
  }
}

export function workspaceName(cwd: string): string {
  return basename(cwd || process.cwd());
}

export function parseRepoSlug(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;
  // scp-like: git@host:owner/repo(.git)
  const scp = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  let path: string | undefined;
  if (scp) {
    path = scp[1];
  } else {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  }
  if (!path) return undefined;
  const segments = path
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  if (segments.length < 2) return undefined;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

// owner/repo from `git config --get remote.origin.url`, resolved ASYNCHRONOUSLY so the
// git subprocess never blocks the event loop (and thus pi's first prompt). Cached per
// cwd. Best-effort: any error or timeout resolves to undefined.
export function repoSlug(cwd: string): Promise<string | undefined> {
  const key = cwd || process.cwd();
  const cached = repoSlugCache.get(key);
  if (cached) return cached;
  const pending = new Promise<string | undefined>((resolve) => {
    execFile(
      'git',
      ['-C', key, 'config', '--get', 'remote.origin.url'],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        resolve(error || typeof stdout !== 'string' ? undefined : parseRepoSlug(stdout));
      },
    );
  });
  repoSlugCache.set(key, pending);
  return pending;
}

// The session span's SYNCHRONOUS source-attribution attributes, keyed exactly as emitted
// on the span. Best-effort values may be undefined, leaving the attribute omitted. The
// repo slug is intentionally NOT here — it is a git lookup, resolved asynchronously via
// repoSlug() and attached by openSessionSpan when ready, so the first prompt is never
// blocked on git.
export function sessionAttributes(cwd: string): Record<string, string | undefined> {
  return {
    'traceroot.pi.workspace': workspaceName(cwd),
    'traceroot.pi.hostname': hostName(),
    'traceroot.pi.username': userName(),
    'traceroot.pi.os': process.platform,
    'traceroot.pi.extension_version': EXTENSION_VERSION,
  };
}
