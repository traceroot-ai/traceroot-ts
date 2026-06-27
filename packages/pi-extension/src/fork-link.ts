// Persist a session's root SpanContext so a later forked session can link back to
// it (P2-F). Keyed by the session file's basename under the configured state dir.
// All operations are best-effort; failure degrades to "no link", never an error.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isSpanId, isTraceId } from './hex.ts';

export interface PersistedTrace {
  traceId: string;
  spanId: string;
}

// Key by a hash of the FULL session-file path, not just its basename: two sessions with
// the same filename in different directories would otherwise collide and cross-link.
function fileFor(stateDir: string, sessionFile: string): string {
  const key = createHash('sha256').update(sessionFile).digest('hex').slice(0, 32);
  return join(stateDir, `${key}.json`);
}

export function persistSessionTrace(
  stateDir: string,
  sessionFile: string | null,
  trace: PersistedTrace,
): void {
  try {
    if (!sessionFile) return;
    mkdirSync(stateDir, { recursive: true });
    // Write atomically (temp file + rename) so a concurrently-forking session never
    // reads a half-written file.
    const target = fileFor(stateDir, sessionFile);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(trace), 'utf8');
    renameSync(tmp, target);
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
