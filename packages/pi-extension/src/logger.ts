// Optional JSON-lines debug log to a file, for diagnosing tracing in environments
// where stderr is not visible. Best-effort: any failure is swallowed so logging
// never affects the pi session. A no-op logger is returned when no path is set.
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileLogger {
  log(level: string, message: string, data?: unknown): void;
}

const NOOP: FileLogger = { log() {} };

export function createFileLogger(filePath: string | undefined): FileLogger {
  if (!filePath) return NOOP;
  let secured = false;
  return {
    log(level, message, data) {
      try {
        if (!secured) {
          // Owner-only: the debug log can contain workspace paths, the repo slug, and
          // model/id data, so it must not be group/world readable.
          mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
        }
        const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, data });
        appendFileSync(filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
        if (!secured) {
          // The mode option above only applies when the file is freshly CREATED; a
          // pre-existing log would keep its old (possibly broad) permissions. Enforce
          // owner-only explicitly once the file exists. The directory is left as-is when
          // it pre-exists (chmod-ing a possibly shared directory would be overreach; the
          // file's 0600 protects the log contents regardless of directory permissions).
          chmodSync(filePath, 0o600);
          secured = true;
        }
      } catch {
        /* logging is best-effort and must never affect the session */
      }
    },
  };
}
