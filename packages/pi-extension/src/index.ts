// traceroot-pi-extension entry point.
//
// pi loads this default-exported factory and passes the ExtensionAPI. We load
// config, gate on the opt-in flag, wire the tracing provider, and register one
// handler module per concern. Any failure during setup is caught and the
// extension returns quietly — pi must never crash because tracing failed.
import { loadConfig } from "./config.ts";
import { initTracing } from "./provider.ts";
import { createSpanState } from "./state.ts";
import { registerSession } from "./handlers/session.ts";
import { registerTurn } from "./handlers/turn.ts";
import { registerLlm } from "./handlers/llm.ts";
import { registerTool } from "./handlers/tool.ts";
import { registerPhase2 } from "./handlers/phase2.ts";
import { registerCommand } from "./handlers/command.ts";
import type { Runtime } from "./runtime.ts";
import type { ExtensionAPI } from "./types.ts";

function warn(message: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : "";
  console.error(`[traceroot-pi-extension] ${message}${detail}`);
}

export default async function (pi: ExtensionAPI): Promise<void> {
  let bundle;
  try {
    bundle = await loadConfig();
  } catch (err) {
    warn("failed to load config; tracing disabled", err);
    return;
  }

  const { config, envProvided } = bundle;
  if (!config.enabled) return; // opt-in: no listeners registered when disabled

  if (!config.token) {
    warn("TRACEROOT_PI_ENABLED is true but no token is set; spans will be rejected. Set TRACEROOT_TOKEN.");
  }

  let tracing;
  try {
    tracing = initTracing(config);
  } catch (err) {
    warn("failed to initialize tracing; tracing disabled", err);
    return;
  }

  const state = createSpanState();
  const rt: Runtime = {
    pi,
    config,
    envProvided,
    tracer: tracing.tracer,
    provider: tracing.provider,
    state,
    debug: (...args: unknown[]) => {
      if (config.debug) console.error("[traceroot]", ...args);
    },
  };

  try {
    registerSession(rt);
    registerTurn(rt);
    registerLlm(rt);
    registerTool(rt);
    registerPhase2(rt);
    registerCommand(rt);
  } catch (err) {
    warn("failed to register handlers", err);
    return;
  }

  rt.debug("registered; endpoint=", config.otlpEndpoint, "project=", config.project);
}
