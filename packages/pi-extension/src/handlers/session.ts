// Session lifecycle: capture fork origin on start; close everything and flush on
// shutdown. The session span itself is opened lazily in turn.ts on first agent_start.
import { setAttr } from "../attributes.ts";
import { closeAllOpenSpans } from "../state.ts";
import { readSessionTrace } from "../fork-link.ts";
import { setStatus, STATUS_INACTIVE } from "../ui.ts";
import type { Runtime } from "../runtime.ts";
import type { ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "../types.ts";

const FLUSH_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerSession(rt: Runtime): void {
  const { pi, state, provider, config, debug } = rt;

  pi.on("session_start", async (raw) => {
    const event = raw as SessionStartEvent;
    state.sessionStartReason = event?.reason ?? null;
    debug("session_start reason=", event?.reason);
    if (event?.reason === "fork" && event?.previousSessionFile) {
      state.forkedFromSessionFile = event.previousSessionFile;
      state.forkLink = readSessionTrace(config.stateDir, event.previousSessionFile);
      debug("fork link", state.forkLink ? "found" : "none");
    }
  });

  pi.on("session_shutdown", async (raw, ctx) => {
    const event = raw as SessionShutdownEvent;
    setStatus(ctx as ExtensionContext, STATUS_INACTIVE);
    // The last assistant response is the session's Output panel.
    if (state.sessionSpan && state.lastAssistantText) {
      setAttr(state.sessionSpan, "traceroot.span.output", state.lastAssistantText);
    }
    closeAllOpenSpans(state, event?.reason ?? "unknown");
    try {
      await Promise.race([provider.forceFlush(), delay(FLUSH_TIMEOUT_MS)]);
    } catch {
      /* flush is best-effort on exit */
    }
    try {
      await provider.shutdown();
    } catch {
      /* shutdown is best-effort on exit */
    }
    debug("flushed + shutdown");
  });
}
