// Build a scannable span name for a tool call: "<tool>: <file>" when an argument
// names a path, "bash: <command>" for shell calls, else just the tool name. Keeps
// a trace waterfall readable without expanding each span. Pure (no OTel import).
import { basename } from 'node:path';

const MAX_BASH_NAME = 60;

export function formatToolSpanName(toolName: string, args: unknown): string {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    const pathLike = a.path ?? a.file ?? a.filePath ?? a.target;
    if (typeof pathLike === 'string' && pathLike) return `${toolName}: ${basename(pathLike)}`;
    if (toolName === 'bash' && typeof a.command === 'string' && a.command) {
      const cmd = a.command.replace(/\s+/g, ' ').trim();
      return `bash: ${cmd.length > MAX_BASH_NAME ? `${cmd.slice(0, MAX_BASH_NAME)}…` : cmd}`;
    }
  }
  return toolName;
}
