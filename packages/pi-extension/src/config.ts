// Layered configuration for the extension.
//
// Precedence (later overrides earlier):
//   1. Hardcoded defaults
//   2. ~/.pi/agent/traceroot.json            (global, user home)
//   3. Environment variables                  (highest)
//
// Project-local .pi/traceroot.json is applied separately and only when the
// project is trusted (see project-config.ts), and only for presentation fields —
// so an untrusted repo can never inject configuration or set the token/endpoint.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ConfigIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export type MetadataValue = string | number | boolean;

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
  logFile?: string;
  captureFullPayload: boolean;
  captureToolIo: boolean;
  showUiIndicator: boolean;
  stateDir: string;
  parentSpanId?: string;
  rootSpanId?: string;
  additionalMetadata?: Record<string, MetadataValue>;
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
  logFile: string;
  captureFullPayload: boolean;
  captureToolIo: boolean;
  showUiIndicator: boolean;
  stateDir: string;
  parentSpanId: string;
  rootSpanId: string;
  additionalMetadata: Record<string, unknown>;
}>;

export interface ConfigBundle {
  config: TracerootPiConfig;
  /** Config keys whose value came from an environment variable (env wins over project-local). */
  envProvided: Set<keyof TracerootPiConfig>;
  /** Validation problems to surface (UI + log). Empty when config is clean. */
  configIssues: ConfigIssue[];
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

// Accept the common truthy/falsey spellings (case-insensitive, trimmed) so an env
// boolean is not silently treated as false when set to "1"/"yes"/"on" etc. An unset,
// empty, or unrecognized value falls through to the lower-precedence layer / default.
function boolEnv(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const normalized = v.trim().toLowerCase();
  if (normalized === '') return undefined;
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function strEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function jsonObjectEnv(name: string): Record<string, unknown> | undefined {
  const v = strEnv(name);
  if (v === undefined) return undefined;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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
    enabled: firstBoolEnv('TRACEROOT_ENABLED', 'TRACEROOT_PI_ENABLED'),
    token: firstStrEnv('TRACEROOT_API_KEY', 'TRACEROOT_TOKEN'),
    localMode: boolEnv('TRACEROOT_LOCAL_MODE'),
    apiUrl: firstStrEnv('TRACEROOT_HOST_URL', 'TRACEROOT_API_URL'),
    otlpEndpoint: strEnv('TRACEROOT_OTLP_ENDPOINT'),
    uiUrl: strEnv('TRACEROOT_UI_URL'),
    project: strEnv('TRACEROOT_PROJECT'),
    projectId: strEnv('TRACEROOT_PROJECT_ID'),
    serviceName: strEnv('TRACEROOT_SERVICE_NAME'),
    environment: strEnv('TRACEROOT_ENVIRONMENT'),
    githubOwner: strEnv('TRACEROOT_GITHUB_OWNER'),
    githubRepo: strEnv('TRACEROOT_GITHUB_REPO_NAME'),
    githubCommit: strEnv('TRACEROOT_GITHUB_COMMIT_HASH'),
    debug: boolEnv('TRACEROOT_PI_DEBUG'),
    logFile: strEnv('TRACEROOT_LOG_FILE'),
    captureFullPayload: boolEnv('TRACEROOT_CAPTURE_FULL_PAYLOAD'),
    captureToolIo: boolEnv('TRACEROOT_CAPTURE_TOOL_IO'),
    showUiIndicator: boolEnv('TRACEROOT_SHOW_UI'),
    stateDir: strEnv('TRACEROOT_STATE_DIR'),
    parentSpanId: strEnv('PI_PARENT_SPAN_ID'),
    rootSpanId: strEnv('PI_ROOT_SPAN_ID'),
    additionalMetadata: jsonObjectEnv('TRACEROOT_ADDITIONAL_METADATA'),
  });
}

export function readJsonConfig(file: string): RawConfig | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as RawConfig) : null;
  } catch {
    return null;
  }
}

// Keep only primitive values; arbitrary metadata is emitted as span attributes,
// which OpenTelemetry restricts to string/number/boolean.
function primitiveMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, MetadataValue> | undefined {
  if (!value) return undefined;
  const out: Record<string, MetadataValue> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolve(raw: RawConfig): TracerootPiConfig {
  const localMode = raw.localMode ?? false;
  const apiUrl = raw.apiUrl ?? (localMode ? 'http://localhost:8000' : 'https://app.traceroot.ai');
  const uiUrl = raw.uiUrl ?? (localMode ? 'http://localhost:3000' : 'https://app.traceroot.ai');
  const otlpEndpoint = raw.otlpEndpoint ?? `${apiUrl.replace(/\/+$/, '')}/api/v1/public/traces`;
  return {
    enabled: raw.enabled ?? false,
    token: raw.token ?? '',
    localMode,
    apiUrl,
    otlpEndpoint,
    uiUrl,
    project: raw.project ?? 'pi',
    projectId: raw.projectId,
    serviceName: raw.serviceName ?? 'pi-agent',
    environment: raw.environment ?? 'development',
    githubOwner: raw.githubOwner,
    githubRepo: raw.githubRepo,
    githubCommit: raw.githubCommit,
    debug: raw.debug ?? false,
    logFile: raw.logFile,
    captureFullPayload: raw.captureFullPayload ?? false,
    captureToolIo: raw.captureToolIo ?? true,
    showUiIndicator: raw.showUiIndicator ?? true,
    stateDir: raw.stateDir ?? join(homedir(), '.pi', 'agent', 'state', 'traceroot-pi-extension'),
    parentSpanId: raw.parentSpanId,
    rootSpanId: raw.rootSpanId,
    additionalMetadata: primitiveMetadata(raw.additionalMetadata),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Surface the misconfigurations that actually break or weaken tracing.
export function validateConfig(config: TracerootPiConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const name of ['apiUrl', 'uiUrl', 'otlpEndpoint'] as const) {
    if (!isHttpUrl(config[name])) {
      issues.push({ path: name, message: `${name} must be an http(s) URL`, severity: 'error' });
    }
  }
  if (config.enabled && !config.token) {
    issues.push({
      path: 'token',
      message: 'tracing is enabled but no token is set (TRACEROOT_API_KEY); spans will be rejected',
      severity: 'warning',
    });
  }
  if (config.enabled && !config.localMode && config.otlpEndpoint.startsWith('http://')) {
    issues.push({
      path: 'otlpEndpoint',
      message: 'endpoint is not https; the token will be sent in cleartext',
      severity: 'warning',
    });
  }
  return issues;
}

export function loadConfig(): ConfigBundle {
  const globalFile = join(homedir(), '.pi', 'agent', 'traceroot.json');
  const globalLayer = readJsonConfig(globalFile);
  const env = envRaw();
  const merged = mergeRaw(globalLayer, env);
  const config = resolve(merged);
  const envProvided = new Set(Object.keys(env) as Array<keyof TracerootPiConfig>);

  const configIssues: ConfigIssue[] = [];
  if (globalLayer === null && existsSync(globalFile)) {
    configIssues.push({
      path: globalFile,
      message: 'config file is not valid JSON; ignored',
      severity: 'warning',
    });
  }
  configIssues.push(...validateConfig(config));

  return { config, envProvided, configIssues };
}
