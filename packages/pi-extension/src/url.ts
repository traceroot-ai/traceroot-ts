// Build a deep link to a trace in the Traceroot web UI.
//
// The UI route is /projects/{projectId}/traces?traceId={traceId}, where projectId
// is the project UUID (not the human-readable project name). When the UUID is not
// configured we cannot construct a correct link, so we return null and the caller
// surfaces the trace id as plain text instead of a wrong URL.
import type { TracerootPiConfig } from './config.ts';

export function buildTraceUrl(config: TracerootPiConfig, traceId: string | null): string | null {
  if (!traceId || !config.projectId) return null;
  const base = config.uiUrl.replace(/\/+$/, '');
  return `${base}/projects/${config.projectId}/traces?traceId=${traceId}`;
}
