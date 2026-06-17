// Project-local configuration (.pi/traceroot.json), applied only when the project
// is trusted. For security this layer can only set non-sensitive, presentation-level
// fields — never the token, endpoint, or service identity. Environment variables
// still win over it.
import { join } from "node:path";
import { readJsonConfig, type RawConfig, type TracerootPiConfig } from "./config.ts";

// Fields a trusted project-local file is permitted to override.
const PROJECT_LOCAL_FIELDS = ["project", "projectId", "showUiIndicator", "debug"] as const;
type ProjectLocalField = (typeof PROJECT_LOCAL_FIELDS)[number];

export function readProjectLocalConfig(cwd: string): RawConfig | null {
  return readJsonConfig(join(cwd, ".pi", "traceroot.json"));
}

// Mutates config in place with allowed project-local fields that env did not set.
// Returns the list of applied field names (for debug logging).
export function applyProjectLocal(
  config: TracerootPiConfig,
  raw: RawConfig,
  envProvided: Set<keyof TracerootPiConfig>,
): ProjectLocalField[] {
  const applied: ProjectLocalField[] = [];
  for (const field of PROJECT_LOCAL_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (envProvided.has(field)) continue;
    (config as unknown as Record<string, unknown>)[field] = value;
    applied.push(field);
  }
  return applied;
}
