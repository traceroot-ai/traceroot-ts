// src/project-id.ts — per-root project attribution (internal export mode only).
//
// The project id travels in the OTel Context (not AsyncLocalStorage): the root span
// is started against a context carrying the id, descendants inherit that context,
// and TraceRootSpanProcessor.onStart stamps it as a span attribute — which is what
// attributes spans created by third-party auto-instrumentation inside the root's
// scope, since those never see this SDK's API. Internal-mode state lives in
// trace-id.ts (see the note there about import cycles).
import { Context, createContextKey } from '@opentelemetry/api';
import { isInternalMode } from './trace-id';

/** Span attribute the backend routes by; stripped server-side before storage. */
export const PROJECT_ID_ATTR = 'traceroot.project_id';

const PROJECT_ID_CONTEXT_KEY = createContextKey('traceroot-project-id');

let _hasWarnedPublicIgnore = false;

/** Throws TypeError unless `projectId` is a non-empty string. */
export function assertValidProjectId(projectId: unknown): asserts projectId is string {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new TypeError(
      `[TraceRoot] projectId must be a non-empty string, got: ${JSON.stringify(projectId)}`,
    );
  }
}

/**
 * Validate + gate a per-root project id. Throws TypeError on a malformed id in ANY
 * mode (a bad id is a programming error). Returns true when the id should be
 * attached; outside internal export mode, warns once and returns false so callers
 * fall back to fully normal behavior.
 */
export function shouldAttachProjectId(projectId: unknown): boolean {
  assertValidProjectId(projectId);
  if (!isInternalMode()) {
    if (!_hasWarnedPublicIgnore) {
      _hasWarnedPublicIgnore = true;
      console.warn(
        '[TraceRoot] per-root projectId is only honored in internal export mode; ignoring it.',
      );
    }
    return false;
  }
  return true;
}

/** Return `ctx` with `projectId` set so spans started under it get attributed. */
export function contextWithProjectId(ctx: Context, projectId: string): Context {
  return ctx.setValue(PROJECT_ID_CONTEXT_KEY, projectId);
}

/** Read the project id carried by `ctx`, if any. */
export function projectIdFromContext(ctx: Context): string | undefined {
  return ctx.getValue(PROJECT_ID_CONTEXT_KEY) as string | undefined;
}

/** @internal — reset warn-once state between tests. */
export function _resetProjectIdState(): void {
  _hasWarnedPublicIgnore = false;
}
