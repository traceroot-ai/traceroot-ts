// Session lifecycle: capture fork origin on start; close everything and flush on
// shutdown. The session span itself is opened lazily in turn.ts on first agent_start.
import { SpanKind } from "@opentelemetry/api";
import { setAttr } from "../attributes.ts";
import { closeAllOpenSpans } from "../state.ts";
import { readSessionTrace } from "../fork-link.ts";
import { isSpanId, isTraceId } from "../hex.ts";
import { setStatus, STATUS_INACTIVE } from "../ui.ts";
import type { Runtime } from "../runtime.ts";
import type {
  ExtensionContext,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "../types.ts";

const FLUSH_TIMEOUT_MS = 5000;

// Best-effort flush bounded by a non-blocking timeout. The timeout timer is unref'd
// and always cleared, so a flush that resolves first never leaves an armed timer
// holding Node's event loop open (which would delay pi's exit by up to the timeout).
async function flushWithTimeout(provider: { forceFlush: () => Promise<void> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      provider.forceFlush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    /* flush is best-effort */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerSession(rt: Runtime): void {
  const { pi, state, provider, config, debug } = rt;

  pi.on("session_start", async (raw, rawCtx) => {
    const event = raw as SessionStartEvent;
    const ctx = rawCtx as ExtensionContext;
    const reason = event?.reason;
    state.sessionStartReason = reason ?? null;
    debug("session_start reason=", reason);

    // New session in a reused instance: clear any linkage captured by a prior
    // fork/resume so it cannot leak into this session's root span. The branches
    // below re-populate these for the current session's reason.
    state.forkLink = null;
    state.forkedFromSessionFile = null;
    state.resumeFrom = null;

    // Fork: link the new session's trace back to the parent it branched from.
    if (reason === "fork" && event?.previousSessionFile) {
      state.forkedFromSessionFile = event.previousSessionFile;
      state.forkLink = readSessionTrace(config.stateDir, event.previousSessionFile);
      debug("fork link", state.forkLink ? "found" : "none");
      return;
    }

    // Reload/resume: continue the same trace by parenting new spans under the
    // persisted root (OTel can't reopen the original span across instances).
    if (reason === "reload" || reason === "resume") {
      let sessionFile: string | null = null;
      try {
        sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
      } catch {
        sessionFile = null;
      }
      const prior = readSessionTrace(config.stateDir, sessionFile);
      if (prior) {
        const valid = isTraceId(prior.traceId) && isSpanId(prior.spanId);
        if (valid) {
          state.resumeFrom = prior;
        }
        debug("session continuation", valid ? "found" : "invalid-id");
      }
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

    // Always flush the just-closed spans. Only fully shut the provider down on a
    // terminal quit: reload/new/resume/fork tear down THIS session while the process
    // and the single shared provider live on, and an OTel provider returns no-op
    // tracers after shutdown — shutting it down here would silently drop every span of
    // the next session in a reused instance (the cubic provider-reuse regression).
    await flushWithTimeout(provider);
    if (event?.reason === "quit") {
      try {
        await provider.shutdown();
      } catch {
        /* shutdown is best-effort on exit */
      }
      state.providerShutdown = true;
      debug("flushed + shutdown (quit)");
    } else {
      debug(`flushed (session transition: ${event?.reason ?? "unknown"})`);
    }
  });

  // P2-C — compaction as a timed child span on the session.
  pi.on("session_before_compact", async () => {
    if (state.sessionDisabled || !state.sessionSpan || state.compactionSpan) return;
    state.compactionSpan = rt.tracer.startSpan(
      "pi.compaction",
      { kind: SpanKind.INTERNAL },
      state.sessionCtx ?? undefined,
    );
  });

  pi.on("session_compact", async (raw) => {
    const event = raw as SessionCompactEvent;
    const tokensBefore = event?.compactionEntry?.tokensBefore ?? 0;
    // Open lazily if before_compact never fired, so the compaction still records.
    let span = state.compactionSpan;
    if (!span) {
      if (!state.sessionSpan) return;
      span = rt.tracer.startSpan("pi.compaction", { kind: SpanKind.INTERNAL }, state.sessionCtx ?? undefined);
    }
    setAttr(span, "traceroot.pi.tokens_before", tokensBefore);
    span.end();
    state.compactionSpan = null;
  });
}
