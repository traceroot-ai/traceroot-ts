// Session lifecycle: capture fork origin on start; close everything and flush on
// shutdown. The session span itself is opened lazily in turn.ts on first agent_start.
import { SpanKind } from '@opentelemetry/api';
import { endSpan, setAttr } from '../attributes.ts';
import { beginNewSession, closeAllOpenSpans } from '../state.ts';
import { readSessionTrace } from '../fork-link.ts';
import { isSpanId, isTraceId } from '../hex.ts';
import { setStatus, STATUS_INACTIVE } from '../ui.ts';
import type { Runtime } from '../runtime.ts';
import type {
  ExtensionContext,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from '../types.ts';

const FLUSH_TIMEOUT_MS = 5000;

type FlushOutcome = 'flushed' | 'timeout' | 'error';

// Race a promise against a non-blocking timeout. The timer is unref'd and always cleared,
// so it never holds Node's event loop open (which would delay pi's exit by up to the
// deadline). Returns the work's value, or 'timeout' if the deadline wins first.
async function raceWithTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Best-effort flush that reports its actual outcome, so a backend outage at session end
// is logged honestly ('error'/'timeout') rather than as a misleading 'flushed'.
async function flushWithTimeout(provider: {
  forceFlush: () => Promise<void>;
}): Promise<FlushOutcome> {
  const work = provider
    .forceFlush()
    .then((): FlushOutcome => 'flushed')
    .catch((): FlushOutcome => 'error');
  return raceWithTimeout(work, FLUSH_TIMEOUT_MS);
}

export function registerSession(rt: Runtime): void {
  const { pi, state, provider, config, debug } = rt;

  pi.on('session_start', async (raw, rawCtx) => {
    const event = raw as SessionStartEvent;
    const ctx = rawCtx as ExtensionContext;
    const reason = event?.reason;

    // pi reuses one extension-module instance across sessions, firing
    // session_shutdown -> session_start on every transition. Start each session from a
    // clean slate (close anything still open, then clear the turn counter, model, last
    // output, buffered input, linkage, and the project-finalized flag) so the previous
    // session cannot bleed into this one. The provider is process-scoped and untouched.
    // resetForNewSession clears sessionStartReason, so set it after.
    beginNewSession(state, reason ?? 'new');
    state.sessionStartReason = reason ?? null;
    debug('session_start reason=', reason);

    // Fork: link the new session's trace back to the parent it branched from.
    if (reason === 'fork' && event?.previousSessionFile) {
      state.forkedFromSessionFile = event.previousSessionFile;
      state.forkLink = readSessionTrace(config.stateDir, event.previousSessionFile);
      debug('fork link', state.forkLink ? 'found' : 'none');
      return;
    }

    // Reload/resume: continue the same trace by parenting new spans under the
    // persisted root (OTel can't reopen the original span across instances).
    if (reason === 'reload' || reason === 'resume') {
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
        debug('session continuation', valid ? 'found' : 'invalid-id');
      }
    }
  });

  pi.on('session_shutdown', async (raw, ctx) => {
    const event = raw as SessionShutdownEvent;
    setStatus(ctx as ExtensionContext, STATUS_INACTIVE);
    // The last assistant response is the session's Output panel.
    if (state.sessionSpan && state.lastAssistantText) {
      setAttr(state.sessionSpan, 'traceroot.span.output', state.lastAssistantText);
    }
    closeAllOpenSpans(state, event?.reason ?? 'unknown');

    // Always flush the just-closed spans. Only fully shut the provider down on a
    // terminal quit: reload/new/resume/fork tear down THIS session while the process
    // and the single shared provider live on, and an OTel provider returns no-op
    // tracers after shutdown — shutting it down here would silently drop every span of
    // the next session in a reused instance (the cubic provider-reuse regression).
    const outcome = await flushWithTimeout(provider);
    if (event?.reason === 'quit') {
      // The process is exiting; bound shutdown like flush so a hung exporter cannot
      // stall pi's exit. shutdown() runs its own final flush internally.
      await raceWithTimeout(
        provider.shutdown().catch(() => undefined),
        FLUSH_TIMEOUT_MS,
      );
      state.providerShutdown = true;
      debug(`shutdown (quit); flush ${outcome}`);
    } else {
      debug(`flush ${outcome} (session transition: ${event?.reason ?? 'unknown'})`);
    }
  });

  // P2-C — compaction as a timed child span on the session.
  pi.on('session_before_compact', async () => {
    if (state.sessionDisabled || !state.sessionSpan || state.compactionSpan) return;
    state.compactionSpan = rt.tracer.startSpan(
      'pi.compaction',
      { kind: SpanKind.INTERNAL },
      state.sessionCtx ?? undefined,
    );
  });

  pi.on('session_compact', async (raw) => {
    const event = raw as SessionCompactEvent;
    const tokensBefore = event?.compactionEntry?.tokensBefore ?? 0;
    // Open lazily if before_compact never fired, so the compaction still records.
    let span = state.compactionSpan;
    if (!span) {
      if (!state.sessionSpan) return;
      span = rt.tracer.startSpan(
        'pi.compaction',
        { kind: SpanKind.INTERNAL },
        state.sessionCtx ?? undefined,
      );
    }
    setAttr(span, 'traceroot.pi.tokens_before', tokensBefore);
    endSpan(span);
    state.compactionSpan = null;
  });
}
