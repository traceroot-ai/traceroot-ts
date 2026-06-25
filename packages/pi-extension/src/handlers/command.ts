// P2-G — the /traceroot command: status | open | flush | disable | enable.
// All UI output goes through ctx.ui.notify; spawning a browser is guarded by mode.
import { spawn } from "node:child_process";
import { closeAllOpenSpans, resetForNewSession } from "../state.ts";
import { buildTraceUrl } from "../url.ts";
import { setStatus, STATUS_ACTIVE, STATUS_INACTIVE } from "../ui.ts";
import type { Runtime } from "../runtime.ts";
import type { CommandContext } from "../types.ts";

// The launcher command + args for opening a URL on the given platform. Windows
// must go through cmd.exe because `start` is a cmd builtin, not an executable on
// PATH; the empty "" is start's title argument so the URL is not swallowed as a
// window title. Returns null on unsupported platforms.
export function browserLaunch(
  osPlatform: string,
  url: string,
): { command: string; args: string[] } | null {
  if (osPlatform === "darwin") return { command: "open", args: [url] };
  if (osPlatform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (osPlatform === "linux") return { command: "xdg-open", args: [url] };
  return null;
}

// Resolves true only once the child actually spawns. A missing launcher reports
// ENOENT asynchronously via the child's 'error' event (spawn does not throw for
// it), so we listen for it and degrade to false instead of letting it surface as
// an uncaught exception that would crash the host.
function openInBrowser(url: string): Promise<boolean> {
  const launch = browserLaunch(process.platform, url);
  if (!launch) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(launch.command, launch.args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
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
          ctx.ui.notify((await openInBrowser(url)) ? `Opening ${url}` : `Traceroot trace: ${url}`, "info");
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
