// Optional JSON-lines debug log to a file, for diagnosing tracing in environments
// where stderr is not visible. Best-effort: any failure is swallowed so logging
// never affects the pi session. A no-op logger is returned when no path is set.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileLogger {
  log(level: string, message: string, data?: unknown): void;
}

const NOOP: FileLogger = { log() {} };

export function createFileLogger(filePath: string | undefined): FileLogger {
  if (!filePath) return NOOP;
  let dirEnsured = false;
  return {
    log(level, message, data) {
      try {
        if (!dirEnsured) {
          mkdirSync(dirname(filePath), { recursive: true });
          dirEnsured = true;
        }
        const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, data });
        appendFileSync(filePath, `${line}\n`, 'utf8');
      } catch {
        /* logging is best-effort and must never affect the session */
      }
    },
  };
}
