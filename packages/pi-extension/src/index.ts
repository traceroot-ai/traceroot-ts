// traceroot-pi-extension entry point.
//
// pi loads this default-exported factory and passes the ExtensionAPI. We load
// config, gate on the opt-in flag, wire the tracing provider, and register one
// handler module per concern. Any failure during setup is caught and the
// extension returns quietly — pi must never crash because tracing failed.
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createFileLogger } from "./logger.ts";
import { initTracing } from "./provider.ts";
import { createSpanState } from "./state.ts";
import { registerSession } from "./handlers/session.ts";
import { registerTurn } from "./handlers/turn.ts";
import { registerLlm } from "./handlers/llm.ts";
import { registerTool } from "./handlers/tool.ts";
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
    bundle = loadConfig();
  } catch (err) {
    warn("failed to load config; tracing disabled", err);
    return;
  }

  const { config, envProvided, configIssues } = bundle;
  if (!config.enabled) return; // opt-in: no listeners registered when disabled

  const logFile = config.logFile ?? (config.debug ? join(config.stateDir, "traceroot-pi-extension.log") : undefined);
  const fileLogger = createFileLogger(logFile);

  for (const issue of configIssues) {
    const text = `config ${issue.path}: ${issue.message}`;
    warn(text);
    fileLogger.log(issue.severity, text);
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
    configIssues,
    tracer: tracing.tracer,
    provider: tracing.provider,
    state,
    debug: (...args: unknown[]) => {
      if (config.debug) console.error("[traceroot]", ...args);
      fileLogger.log("debug", args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    },
  };

  try {
    registerSession(rt);
    registerTurn(rt);
    registerLlm(rt);
    registerTool(rt);
    registerCommand(rt);
  } catch (err) {
    warn("failed to register handlers", err);
    return;
  }

  rt.debug("registered; endpoint=", config.otlpEndpoint, "project=", config.project);
}
