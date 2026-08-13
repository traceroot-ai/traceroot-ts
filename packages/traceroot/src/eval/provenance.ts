// src/eval/provenance.ts — run metadata + git/ci provenance (parity with
// traceroot-py/traceroot/eval/provenance.py).
//
// Merges caller-supplied run metadata with automatically discovered provenance — git
// (repository/ref/commit/dirty) and CI (provider/build_id) — when available. Reuses the
// SDK's git-context resolution and degrades gracefully everywhere; never raises; captures
// no secrets. Shape:
//   { ...user metadata (wins)..., git: {repository?,ref?,commit?,dirty?}, ci: {provider,build_id?} }

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TraceRoot } from '../traceroot';
import { autoDetectGitContext, gitContextFromFiles, harvestCiGitContext } from '../git_context';

// (env flag that marks the provider, provider name, env var holding the build/run id)
const CI_PROVIDERS: [string, string, string][] = [
  ['GITHUB_ACTIONS', 'github', 'GITHUB_RUN_ID'],
  ['GITLAB_CI', 'gitlab', 'CI_PIPELINE_ID'],
  ['CIRCLECI', 'circleci', 'CIRCLE_BUILD_NUM'],
  ['BUILDKITE', 'buildkite', 'BUILDKITE_BUILD_ID'],
  ['JENKINS_URL', 'jenkins', 'BUILD_NUMBER'],
];

// Only EXACT OID lengths are commits (SHA-1 = 40, SHA-256 = 64). A shorter hex-looking
// branch/tag (e.g. "deadbeef") must stay a ref, not be reported as a commit.
const COMMIT_OID = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/** (repository, ref) using the same precedence as the client; prefers the value already
 *  resolved on the client so no extra git warning is emitted. The ref may be a branch or tag,
 *  not a commit SHA — see gitBlock. `refIsOid` records whether the SOURCE resolved an object id
 *  (GITHUB_SHA, `.git` HEAD, `git rev-parse HEAD`) rather than handing us an arbitrary name. */
function resolvedGit(
  env: NodeJS.ProcessEnv,
  cwd: string,
): {
  repo: string | null;
  ref: string | null;
  refIsOid: boolean;
} {
  const creds = TraceRoot as unknown as { gitRepo?: string; gitRef?: string };
  let repo = creds.gitRepo ?? null;
  let ref = creds.gitRef ?? null;
  repo = repo || env['TRACEROOT_GIT_REPO'] || null;
  ref = ref || env['TRACEROOT_GIT_REF'] || null;
  // A client-resolved or explicitly configured ref is whatever the caller put there — it may be a
  // branch name that merely LOOKS like an object id.
  let refIsOid = false;
  if (repo === null || ref === null) {
    // Every one of these resolves an OID: GITHUB_SHA, the sha behind .git/HEAD, `rev-parse HEAD`.
    for (const src of [
      harvestCiGitContext(env),
      gitContextFromFiles(cwd),
      autoDetectGitContext(),
    ]) {
      repo = repo || src.gitRepo || null;
      if (ref === null && src.gitRef) {
        ref = src.gitRef;
        refIsOid = true;
      }
      if (repo && ref) break;
    }
  }
  return { repo, ref, refIsOid };
}

/** Whether `name` is an existing branch/tag in `cwd`'s repository, read straight from `.git`
 *  (loose ref file, then packed-refs) — no subprocess, and only ever consulted for a ref that
 *  already has the shape of an object id. False when it cannot be determined. */
function refNamesBranchOrTag(name: string, cwd: string): boolean {
  const gitDir = join(cwd, '.git');
  for (const kind of ['heads', 'tags']) {
    if (existsSync(join(gitDir, 'refs', kind, name))) return true;
  }
  try {
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split(/\r?\n/)) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const target = line.slice(line.indexOf(' ') + 1).trim();
      if (target === `refs/heads/${name}` || target === `refs/tags/${name}`) return true;
    }
  } catch {
    /* no packed-refs (or no repo at all) */
  }
  return false;
}

/** Best-effort working-tree cleanliness. null when it cannot be determined. Never throws. */
export function gitDirty(): boolean | null {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

function gitBlock(
  env: NodeJS.ProcessEnv,
  detectDirty: boolean,
  cwd: string,
): Record<string, unknown> | null {
  const { repo, ref, refIsOid } = resolvedGit(env, cwd);
  const block: Record<string, unknown> = {};
  if (repo) block.repository = repo;
  if (ref) {
    // git ref may be a branch/tag, not a commit SHA. Always expose it as `ref`, but only
    // populate `commit` when it really IS one, so we never report a branch name as a commit
    // (parity with traceroot-py provenance._git_block). Shape alone does not settle it: a branch
    // may legally be NAMED 40 hex chars, so a ref of unproven origin is checked against the work
    // tree's refs first. A resolver that returned an object id needs no check.
    block.ref = ref;
    if (COMMIT_OID.test(ref) && (refIsOid || !refNamesBranchOrTag(ref, cwd))) block.commit = ref;
  }
  if (detectDirty) {
    const dirty = gitDirty();
    if (dirty !== null) block.dirty = dirty;
  }
  return Object.keys(block).length > 0 ? block : null;
}

function ciBlock(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  for (const [flag, provider, buildVar] of CI_PROVIDERS) {
    if (env[flag]) {
      const block: Record<string, unknown> = { provider };
      const buildId = env[buildVar];
      if (buildId) block.build_id = buildId;
      return block;
    }
  }
  if (env['CI']) return { provider: 'ci' };
  return null;
}

/** Build run metadata = user metadata + auto git/ci provenance (when available). User keys
 *  win on conflict. Returns null when there is nothing to record. `cwd` is the work tree whose
 *  `.git` is read (defaults to the process's). */
export function collectRunProvenance(
  userMetadata?: Record<string, unknown> | null,
  opts: { env?: NodeJS.ProcessEnv; detectDirty?: boolean; cwd?: string } = {},
): Record<string, unknown> | null {
  const env = opts.env ?? process.env;
  const meta: Record<string, unknown> = {};
  // Default OFF: dirty detection spawns a synchronous `git status`, so a direct caller shouldn't
  // pay that (and block the event loop) unless it explicitly opts in.
  const git = gitBlock(env, opts.detectDirty ?? false, opts.cwd ?? process.cwd());
  if (git) meta.git = git;
  const ci = ciBlock(env);
  if (ci) meta.ci = ci;
  const merged = userMetadata ? { ...meta, ...userMetadata } : meta;
  return Object.keys(merged).length > 0 ? merged : null;
}
