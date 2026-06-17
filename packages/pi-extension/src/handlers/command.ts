// P2-G — the /traceroot command: status | open | flush | disable | enable.
// All UI output goes through ctx.ui.notify; spawning a browser is guarded by mode.
import { spawn } from "node:child_process";
import { closeAllOpenSpans, resetForNewSession } from "../state.ts";
import { buildTraceUrl } from "../url.ts";
import { setStatus, STATUS_ACTIVE, STATUS_INACTIVE } from "../ui.ts";
import type { Runtime } from "../runtime.ts";
import type { CommandContext } from "../types.ts";

function openCommand(): string | null {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "start";
  if (process.platform === "linux") return "xdg-open";
  return null;
}

function openInBrowser(url: string): boolean {
  const cmd = openCommand();
  if (!cmd) return false;
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function registerCommand(rt: Runtime): void {
  const { pi, state, config, provider } = rt;
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("traceroot", {
    description: "Traceroot tracing: status | open | flush | disable | enable",
    handler: async (args: string, ctx: CommandContext) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
      const url = buildTraceUrl(config, state.sessionTraceId);

      switch (sub) {
        case "status": {
          const lines = [
            `enabled=${config.enabled}`,
            `project=${config.project}`,
            `endpoint=${config.otlpEndpoint}`,
            state.sessionDisabled ? "session=disabled" : "session=active",
            url ? `trace=${url}` : state.sessionTraceId ? `traceId=${state.sessionTraceId}` : "trace=none yet",
          ];
          ctx.ui.notify(`Traceroot — ${lines.join("  |  ")}`, "info");
          return;
        }
        case "open": {
          if (!url) {
            ctx.ui.notify("Traceroot: no trace URL yet (set TRACEROOT_PROJECT_ID and run a prompt).", "warning");
            return;
          }
          if (ctx.mode !== "tui") {
            ctx.ui.notify(`Traceroot trace: ${url}`, "info");
            return;
          }
          ctx.ui.notify(openInBrowser(url) ? `Opening ${url}` : `Traceroot trace: ${url}`, "info");
          return;
        }
        case "flush": {
          try {
            await provider.forceFlush();
            ctx.ui.notify("Traceroot: flushed.", "info");
          } catch {
            ctx.ui.notify("Traceroot: flush failed.", "error");
          }
          return;
        }
        case "disable": {
          // Finalize the in-flight tree now, then stop opening spans. Re-enabling
          // starts a fresh session span (and a fresh trace) on the next prompt.
          closeAllOpenSpans(state, "disabled");
          resetForNewSession(state);
          state.sessionDisabled = true;
          setStatus(ctx, STATUS_INACTIVE);
          ctx.ui.notify("Traceroot: tracing disabled for this session.", "info");
          return;
        }
        case "enable": {
          state.sessionDisabled = false;
          setStatus(ctx, STATUS_ACTIVE);
          ctx.ui.notify("Traceroot: tracing enabled for this session.", "info");
          return;
        }
        default:
          ctx.ui.notify("Traceroot: usage — /traceroot [status|open|flush|disable|enable]", "info");
      }
    },
  });
}
