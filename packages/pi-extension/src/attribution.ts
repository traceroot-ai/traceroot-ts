// Source attribution for the session span: machine, user, OS, workspace, and the
// git repo slug (derived from the origin remote). All best-effort — a failure
// yields undefined and the attribute is simply omitted, never an error.
import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { basename } from "node:path";
import { EXTENSION_VERSION } from "./version.ts";

const GIT_TIMEOUT_MS = 500;
const repoSlugCache = new Map<string, string | undefined>();

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
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return undefined;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

// owner/repo from `git config --get remote.origin.url`, cached per cwd.
export function repoSlug(cwd: string): string | undefined {
  const key = cwd || process.cwd();
  const cached = repoSlugCache.get(key);
  if (cached !== undefined || repoSlugCache.has(key)) return cached;
  let slug: string | undefined;
  try {
    const result = spawnSync("git", ["-C", key, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status === 0 && typeof result.stdout === "string") slug = parseRepoSlug(result.stdout);
  } catch {
    slug = undefined;
  }
  repoSlugCache.set(key, slug);
  return slug;
}

// The session span's source-attribution attributes, keyed exactly as emitted on
// the span. Best-effort values may be undefined, leaving the attribute omitted.
export function sessionAttributes(cwd: string): Record<string, string | undefined> {
  return {
    "traceroot.pi.workspace": workspaceName(cwd),
    "traceroot.pi.repo": repoSlug(cwd),
    "traceroot.pi.hostname": hostName(),
    "traceroot.pi.username": userName(),
    "traceroot.pi.os": process.platform,
    "traceroot.pi.extension_version": EXTENSION_VERSION,
  };
}
