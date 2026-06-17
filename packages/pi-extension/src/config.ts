// Layered configuration for the extension.
//
// Precedence (later overrides earlier):
//   1. Hardcoded defaults
//   2. ~/.pi/agent/traceroot.json            (global, user home)
//   3. traceroot.config.{ts,js,mjs} in cwd   (project file, P2-H)
//   4. Environment variables                  (highest)
//
// Project-local .pi/traceroot.json is applied separately and only when the
// project is trusted (see project-config.ts), so an untrusted repo cannot inject
// configuration. It is never allowed to set the token.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface TracerootPiConfig {
  enabled: boolean;
  token: string;
  localMode: boolean;
  apiUrl: string;
  otlpEndpoint: string;
  uiUrl: string;
  project: string;
  projectId?: string;
  serviceName: string;
  environment: string;
  githubOwner?: string;
  githubRepo?: string;
  githubCommit?: string;
  debug: boolean;
  captureFullPayload: boolean;
  showUiIndicator: boolean;
  stateDir: string;
  parentSpanId?: string;
  rootSpanId?: string;
}

export type RawConfig = Partial<{
  enabled: boolean;
  token: string;
  localMode: boolean;
  apiUrl: string;
  otlpEndpoint: string;
  uiUrl: string;
  project: string;
  projectId: string;
  serviceName: string;
  environment: string;
  githubOwner: string;
  githubRepo: string;
  githubCommit: string;
  debug: boolean;
  captureFullPayload: boolean;
  showUiIndicator: boolean;
  stateDir: string;
  parentSpanId: string;
  rootSpanId: string;
}>;

export interface ConfigBundle {
  config: TracerootPiConfig;
  /** Config keys whose value came from an environment variable (env wins over project-local). */
  envProvided: Set<keyof TracerootPiConfig>;
}

function mergeRaw(...layers: Array<RawConfig | null | undefined>): RawConfig {
  const out: RawConfig = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(layer) as Array<keyof RawConfig>) {
      const value = layer[key];
      if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function boolEnv(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "true";
}

function strEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

// First defined value across alias names (SDK-standard name first, legacy fallback).
function firstBoolEnv(...names: string[]): boolean | undefined {
  for (const name of names) {
    const v = boolEnv(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

function firstStrEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const v = strEnv(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function envRaw(): RawConfig {
  return mergeRaw({
    // SDK-standard names (TRACEROOT_ENABLED / TRACEROOT_API_KEY) take precedence;
    // the pi-scoped legacy names remain as backward-compatible aliases.
    enabled: firstBoolEnv("TRACEROOT_ENABLED", "TRACEROOT_PI_ENABLED"),
    token: firstStrEnv("TRACEROOT_API_KEY", "TRACEROOT_TOKEN"),
    localMode: boolEnv("TRACEROOT_LOCAL_MODE"),
    apiUrl: firstStrEnv("TRACEROOT_HOST_URL", "TRACEROOT_API_URL"),
    otlpEndpoint: strEnv("TRACEROOT_OTLP_ENDPOINT"),
    uiUrl: strEnv("TRACEROOT_UI_URL"),
    project: strEnv("TRACEROOT_PROJECT"),
    projectId: strEnv("TRACEROOT_PROJECT_ID"),
    serviceName: strEnv("TRACEROOT_SERVICE_NAME"),
    environment: strEnv("TRACEROOT_ENVIRONMENT"),
    githubOwner: strEnv("TRACEROOT_GITHUB_OWNER"),
    githubRepo: strEnv("TRACEROOT_GITHUB_REPO_NAME"),
    githubCommit: strEnv("TRACEROOT_GITHUB_COMMIT_HASH"),
    debug: boolEnv("TRACEROOT_PI_DEBUG"),
    captureFullPayload: boolEnv("TRACEROOT_CAPTURE_FULL_PAYLOAD"),
    showUiIndicator: boolEnv("TRACEROOT_SHOW_UI"),
    stateDir: strEnv("TRACEROOT_STATE_DIR"),
    parentSpanId: strEnv("PI_PARENT_SPAN_ID"),
    rootSpanId: strEnv("PI_ROOT_SPAN_ID"),
  });
}

export function readJsonConfig(file: string): RawConfig | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as RawConfig) : null;
  } catch {
    return null;
  }
}

async function readTsConfig(cwd: string): Promise<RawConfig | null> {
  for (const name of ["traceroot.config.ts", "traceroot.config.mjs", "traceroot.config.js"]) {
    const file = join(cwd, name);
    if (!existsSync(file)) continue;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: RawConfig } & RawConfig;
      const value = mod.default ?? mod;
      if (value && typeof value === "object") return value;
    } catch {
      // Runtime may not transpile .ts here, or the file may throw — degrade silently.
      return null;
    }
  }
  return null;
}

export function resolve(raw: RawConfig): TracerootPiConfig {
  const localMode = raw.localMode ?? false;
  const apiUrl = raw.apiUrl ?? (localMode ? "http://localhost:8000" : "https://api.traceroot.ai");
  const uiUrl = raw.uiUrl ?? (localMode ? "http://localhost:3000" : "https://app.traceroot.ai");
  const otlpEndpoint = raw.otlpEndpoint ?? `${apiUrl.replace(/\/+$/, "")}/api/v1/public/traces`;
  return {
    enabled: raw.enabled ?? false,
    token: raw.token ?? "",
    localMode,
    apiUrl,
    otlpEndpoint,
    uiUrl,
    project: raw.project ?? "pi",
    projectId: raw.projectId,
    serviceName: raw.serviceName ?? "pi-agent",
    environment: raw.environment ?? "development",
    githubOwner: raw.githubOwner,
    githubRepo: raw.githubRepo,
    githubCommit: raw.githubCommit,
    debug: raw.debug ?? false,
    captureFullPayload: raw.captureFullPayload ?? false,
    showUiIndicator: raw.showUiIndicator ?? true,
    stateDir: raw.stateDir ?? join(homedir(), ".pi", "agent", "state", "traceroot-pi-extension"),
    parentSpanId: raw.parentSpanId,
    rootSpanId: raw.rootSpanId,
  };
}

export async function loadConfig(cwd: string = process.cwd()): Promise<ConfigBundle> {
  const globalFile = join(homedir(), ".pi", "agent", "traceroot.json");
  const globalLayer = readJsonConfig(globalFile);
  const tsLayer = await readTsConfig(cwd);
  const env = envRaw();
  const merged = mergeRaw(globalLayer, tsLayer, env);
  const config = resolve(merged);
  const envProvided = new Set(Object.keys(env) as Array<keyof TracerootPiConfig>);
  return { config, envProvided };
}
