// Project-local configuration (.pi/traceroot.json), applied only when the project
// is trusted. For security this layer can only set non-sensitive, presentation-level
// fields — never the token, endpoint, or service identity. Environment variables
// still win over it.
import { join } from 'node:path';
import { readJsonConfig, type RawConfig, type TracerootPiConfig } from './config.ts';

// Fields a trusted project-local file is permitted to override.
const PROJECT_LOCAL_FIELDS = ['project', 'projectId', 'showUiIndicator', 'debug'] as const;
type ProjectLocalField = (typeof PROJECT_LOCAL_FIELDS)[number];

export function readProjectLocalConfig(cwd: string): RawConfig | null {
  return readJsonConfig(join(cwd, '.pi', 'traceroot.json'));
}

// Mutates config in place with allowed project-local fields that env did not set.
// Returns the list of applied field names (for debug logging).
export function applyProjectLocal(
  config: TracerootPiConfig,
  raw: RawConfig,
  envProvided: Set<keyof TracerootPiConfig>,
): ProjectLocalField[] {
  const applied: ProjectLocalField[] = [];
  // Per-field typed assignment. Apply a project-local value only when it is present,
  // env did not already set it, AND its runtime type matches the field — so an
  // untrusted/malformed JSON value (e.g. a numeric projectId or a string debug) is
  // ignored rather than cast straight into typed config.
  const take = (field: ProjectLocalField): boolean =>
    raw[field] !== undefined && !envProvided.has(field);
  if (take('project') && typeof raw.project === 'string') {
    config.project = raw.project;
    applied.push('project');
  }
  if (take('projectId') && typeof raw.projectId === 'string') {
    config.projectId = raw.projectId;
    applied.push('projectId');
  }
  if (take('showUiIndicator') && typeof raw.showUiIndicator === 'boolean') {
    config.showUiIndicator = raw.showUiIndicator;
    applied.push('showUiIndicator');
  }
  if (take('debug') && typeof raw.debug === 'boolean') {
    config.debug = raw.debug;
    applied.push('debug');
  }
  return applied;
}
