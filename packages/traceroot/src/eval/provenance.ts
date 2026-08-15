// src/eval/provenance.ts — run metadata + git/ci provenance (parity with
// traceroot-py/traceroot/eval/provenance.py).
//
// Merges caller-supplied run metadata with automatically discovered provenance — git
// (repository/ref/commit/dirty) and CI (provider/build_id) — when available. Reuses the
// SDK's git-context resolution and degrades gracefully everywhere; never raises; captures
// no secrets. Shape:
//   { ...user metadata (wins)..., git: {repository?,ref?,commit?,dirty?}, ci: {provider,build_id?} }

import { execFileSync } from 'node:child_process';

import { TraceRoot } from '../traceroot';
import { autoDetectGitContext, gitContextFromFiles, harvestCiGitContext } from '../git_context';
import { SDK_VERSION } from '../processor';

// (env flag that marks the provider, provider name, env var holding the build/run id)
const CI_PROVIDERS: [string, string, string][] = [
  ['GITHUB_ACTIONS', 'github', 'GITHUB_RUN_ID'],
  ['GITLAB_CI', 'gitlab', 'CI_PIPELINE_ID'],
  ['CIRCLECI', 'circleci', 'CIRCLE_BUILD_NUM'],
  ['BUILDKITE', 'buildkite', 'BUILDKITE_BUILD_ID'],
  ['JENKINS_URL', 'jenkins', 'BUILD_NUMBER'],
];

const SDK_LANGUAGE = 'typescript';

// Branch/ref env vars set by common CI providers (distinct from the commit SHA).
const CI_BRANCH_VARS = [
  'GITHUB_HEAD_REF',
  'GITHUB_REF_NAME',
  'CI_COMMIT_REF_NAME',
  'CIRCLE_BRANCH',
  'BUILDKITE_BRANCH',
  'GIT_BRANCH',
];

/** (repository, commit) using the same precedence as the client; prefers the value already
 *  resolved on the client so no extra git warning is emitted. */
function resolvedGit(env: NodeJS.ProcessEnv): [string | null, string | null] {
  const creds = TraceRoot as unknown as { gitRepo?: string; gitRef?: string };
  let repo = creds.gitRepo ?? null;
  let ref = creds.gitRef ?? null;
  repo = repo || env['TRACEROOT_GIT_REPO'] || null;
  ref = ref || env['TRACEROOT_GIT_REF'] || null;
  if (repo === null || ref === null) {
    for (const src of [harvestCiGitContext(env), gitContextFromFiles(), autoDetectGitContext()]) {
      repo = repo || src.gitRepo || null;
      ref = ref || src.gitRef || null;
      if (repo && ref) break;
    }
  }
  return [repo, ref];
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

function gitBlock(env: NodeJS.ProcessEnv, detectDirty: boolean): Record<string, unknown> | null {
  const [repo, commit] = resolvedGit(env);
  const block: Record<string, unknown> = {};
  if (repo) block.repository = repo;
  if (commit) {
    block.ref = commit;
    block.commit = commit;
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
 *  win on conflict. Returns null when there is nothing to record. */
export function collectRunProvenance(
  userMetadata?: Record<string, unknown> | null,
  opts: { env?: NodeJS.ProcessEnv; detectDirty?: boolean } = {},
): Record<string, unknown> | null {
  const env = opts.env ?? process.env;
  const meta: Record<string, unknown> = {};
  // Default OFF: dirty detection spawns a synchronous `git status`, so a direct caller shouldn't
  // pay that (and block the event loop) unless it explicitly opts in.
  const git = gitBlock(env, opts.detectDirty ?? false);
  if (git) meta.git = git;
  const ci = ciBlock(env);
  if (ci) meta.ci = ci;
  const merged = userMetadata ? { ...meta, ...userMetadata } : meta;
  return Object.keys(merged).length > 0 ? merged : null;
}

/** Best-effort branch name — distinct from the commit SHA. CI branch env first, then
 *  `git rev-parse --abbrev-ref HEAD`. null on detached HEAD or when unknown. */
function gitBranch(env: NodeJS.ProcessEnv): string | null {
  for (const v of CI_BRANCH_VARS) {
    const b = env[v];
    if (b) return b;
  }
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

/** Typed execution provenance in the backend's flat RunProvenance wire shape (snake_case
 *  keys). Every value is what the SDK can actually observe; absent values are omitted,
 *  never inferred. sdk_language/sdk_version identify the SDK and are always reported when
 *  known.
 *
 *  Distinct from free-form user metadata and never a substitute for the candidate_version
 *  display label. Model/prompt identity is NOT auto-detected — the platform observes actual
 *  models from task-subtree LLM spans — so declared_model/declared_prompt_version are left
 *  for the user to declare. */
export function runProvenance(
  opts: { env?: NodeJS.ProcessEnv; detectDirty?: boolean } = {},
): Record<string, unknown> {
  const env = opts.env ?? process.env;
  const detectDirty = opts.detectDirty ?? true;
  const prov: Record<string, unknown> = {};
  const [repo, commit] = resolvedGit(env);
  if (repo) prov.git_repository = repo;
  const branch = gitBranch(env);
  if (branch) prov.git_ref = branch;
  if (commit) prov.git_commit = commit;
  if (detectDirty) {
    const dirty = gitDirty();
    if (dirty !== null) prov.git_dirty = dirty;
  }
  const ci = ciBlock(env);
  if (ci) {
    prov.ci_provider = ci.provider;
    if (ci.build_id) prov.ci_build_id = ci.build_id;
  }
  prov.sdk_language = SDK_LANGUAGE;
  if (SDK_VERSION) prov.sdk_version = SDK_VERSION;
  return prov;
}
