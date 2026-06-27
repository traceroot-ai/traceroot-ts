// Persist a session's root SpanContext so a later forked session can link back to
// it (P2-F). Keyed by the session file's basename under the configured state dir.
// All operations are best-effort; failure degrades to "no link", never an error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isSpanId, isTraceId } from './hex.ts';

export interface PersistedTrace {
  traceId: string;
  spanId: string;
}

function fileFor(stateDir: string, sessionFile: string): string {
  return join(stateDir, `${basename(sessionFile)}.json`);
}

export function persistSessionTrace(
  stateDir: string,
  sessionFile: string | null,
  trace: PersistedTrace,
): void {
  try {
    if (!sessionFile) return;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(fileFor(stateDir, sessionFile), JSON.stringify(trace), 'utf8');
  } catch {
    /* best-effort */
  }
}

export function readSessionTrace(
  stateDir: string,
  sessionFile: string | null,
): PersistedTrace | null {
  try {
    if (!sessionFile) return null;
    const file = fileFor(stateDir, sessionFile);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // The file is untrusted on read-back: only accept well-formed OTel ids,
    // else a corrupt id would yield an invalid Link/parent SpanContext.
    if (parsed && isTraceId(parsed.traceId) && isSpanId(parsed.spanId)) {
      return { traceId: parsed.traceId, spanId: parsed.spanId };
    }
    return null;
  } catch {
    return null;
  }
}
