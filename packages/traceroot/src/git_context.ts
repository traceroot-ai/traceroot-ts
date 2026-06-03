// src/git_context.ts
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let _gitRootCache: string | null = null; // null = not yet detected, '' = failed

type GitContext = { gitRepo?: string; gitRef?: string };
type Env = Record<string, string | undefined>;

// Treat whitespace-only env vars the same as missing values.
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

// Normalize CI vars or git remote URLs into TraceRoot's owner/repo form.
function normalizeRepo(value: string | undefined): string | undefined {
  const repo = nonEmpty(value);
  if (!repo) return undefined;

  const match = repo.match(/(?:https?:\/\/[^/]+\/|ssh:\/\/git@[^/]+\/|git@[^:]+:)(.+?)(?:\.git)?$/);
  return (match ? match[1] : repo).replace(/\.git$/, '').replace(/^\/+|\/+$/g, '') || undefined;
}

// Local git remotes should only stamp recognized URL forms, never raw filesystem paths.
function normalizeRemoteRepo(value: string | undefined): string | undefined {
  const remote = nonEmpty(value);
  if (!remote) return undefined;

  const match = remote.match(
    /^(?:https?:\/\/[^/]+\/|ssh:\/\/git@[^/]+\/|git@[^:]+:)(.+?)(?:\.git)?$/,
  );
  if (!match) return undefined;
  return match[1].replace(/\.git$/, '').replace(/^\/+|\/+$/g, '') || undefined;
}

// Some platforms split owner and repo name into separate env vars.
function joinRepo(owner: string | undefined, repo: string | undefined): string | undefined {
  const normalizedOwner = nonEmpty(owner)?.replace(/^\/+|\/+$/g, '');
  const normalizedRepo = nonEmpty(repo)?.replace(/^\/+|\/+$/g, '');
  if (!normalizedOwner || !normalizedRepo) return undefined;
  return normalizeRepo(`${normalizedOwner}/${normalizedRepo}`);
}

// Node stack traces can use file:// URLs when running through ESM/tsx.
function stackPathToFilePath(filepath: string): string {
  if (!filepath.startsWith('file://')) return filepath;
  try {
    return fileURLToPath(filepath);
  } catch {
    return filepath;
  }
}

function isCaseInsensitivePlatform(platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function pathStartsWithRoot(
  filepath: string,
  gitRoot: string,
  platform = process.platform,
): boolean {
  const normalizedFilepath = filepath.replaceAll('\\', '/');
  const normalizedGitRoot = gitRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  const caseInsensitive = isCaseInsensitivePlatform(platform);
  const compareFilepath = caseInsensitive ? normalizedFilepath.toLowerCase() : normalizedFilepath;
  const compareGitRoot = caseInsensitive ? normalizedGitRoot.toLowerCase() : normalizedGitRoot;

  if (!compareFilepath.startsWith(compareGitRoot)) return false;
  const nextChar = compareFilepath[compareGitRoot.length];
  return nextChar === undefined || nextChar === '/';
}

/**
 * Harvests git context from common CI/deployment environment variables.
 * Repo and ref are resolved independently, using the first platform that
 * provides each field.
 */
export function harvestCiGitContext(env: Env = process.env): GitContext {
  // Keep this order aligned with the documented resolution table.
  const candidates: GitContext[] = [
    {
      gitRepo: normalizeRepo(env['GITHUB_REPOSITORY']),
      gitRef: nonEmpty(env['GITHUB_SHA']),
    },
    {
      gitRepo: joinRepo(env['VERCEL_GIT_REPO_OWNER'], env['VERCEL_GIT_REPO_SLUG']),
      gitRef: nonEmpty(env['VERCEL_GIT_COMMIT_SHA']),
    },
    {
      gitRepo: normalizeRepo(env['CI_PROJECT_PATH']),
      gitRef: nonEmpty(env['CI_COMMIT_SHA']),
    },
    {
      gitRepo: joinRepo(env['CIRCLE_PROJECT_USERNAME'], env['CIRCLE_PROJECT_REPONAME']),
      gitRef: nonEmpty(env['CIRCLE_SHA1']),
    },
    {
      gitRepo: normalizeRepo(env['BITBUCKET_REPO_FULL_NAME']),
      gitRef: nonEmpty(env['BITBUCKET_COMMIT']),
    },
    {
      gitRef: nonEmpty(env['RENDER_GIT_COMMIT']),
    },
  ];

  const result: GitContext = {};
  for (const candidate of candidates) {
    // A platform may provide only repo or only ref, so fill each field separately.
    if (result.gitRepo === undefined && candidate.gitRepo !== undefined) {
      result.gitRepo = candidate.gitRepo;
    }
    if (result.gitRef === undefined && candidate.gitRef !== undefined) {
      result.gitRef = candidate.gitRef;
    }
    if (result.gitRepo !== undefined && result.gitRef !== undefined) break;
  }
  return result;
}

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

function relativePath(
  filepath: string,
  gitRoot = getGitRoot(),
  platform = process.platform,
): string | undefined {
  const normalizedFilepath = stackPathToFilePath(filepath).replaceAll('\\', '/');
  // Git and Node can disagree on slash style on Windows.
  const normalizedGitRoot = gitRoot?.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalizedGitRoot && pathStartsWithRoot(normalizedFilepath, normalizedGitRoot, platform)) {
    return normalizedFilepath.slice(normalizedGitRoot.length).replace(/^[/\\]/, '');
  }
  // If we can't make the path relative, don't stamp it — avoid leaking absolute paths.
  return undefined;
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
    gitRepo = normalizeRemoteRepo(remote);
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

/** @internal — reset cached git root between tests */
export function _resetGitContextCache(): void {
  _gitRootCache = null;
}

/** @internal — expose path handling without shelling out to git */
export function _relativePathForTesting(
  filepath: string,
  gitRoot: string,
  platform = process.platform,
): string | undefined {
  return relativePath(filepath, gitRoot, platform);
}

/** @internal — expose remote parsing without shelling out to git */
export function _normalizeRemoteRepoForTesting(remote: string): string | undefined {
  return normalizeRemoteRepo(remote);
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
    const normalizedLine = line.replaceAll('\\', '/');
    if (normalizedLine.includes('/packages/traceroot/src/')) continue;
    if (normalizedLine.includes('/node_modules/')) continue;
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
