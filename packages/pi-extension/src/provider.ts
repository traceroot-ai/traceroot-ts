// Tracing provider wiring.
//
// The OTLP/proto exporter + BatchSpanProcessor are the source of truth for export.
// We additionally call the Traceroot SDK's init() best-effort for cloud-side
// attribution/config; if it throws it is swallowed — export does not depend on it.
import { type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import * as traceroot from "traceroot-sdk-ts";
import type { TracerootPiConfig } from "./config.ts";

export interface Tracing {
  tracer: Tracer;
  provider: NodeTracerProvider;
}

const TRACER_NAME = "traceroot-pi-extension";

function bestEffortSdkInit(config: TracerootPiConfig): void {
  try {
    const mod = traceroot as unknown as {
      init?: (cfg: Record<string, unknown>) => void;
      default?: { init?: (cfg: Record<string, unknown>) => void };
    };
    const init = mod.init ?? mod.default?.init;
    init?.({
      token: config.token,
      service_name: config.serviceName,
      environment: config.environment,
      local_mode: config.localMode,
      enable_span_cloud_export: true,
      otlp_endpoint: config.otlpEndpoint,
      ...(config.githubOwner ? { github_owner: config.githubOwner } : {}),
      ...(config.githubRepo ? { github_repo_name: config.githubRepo } : {}),
      ...(config.githubCommit ? { github_commit_hash: config.githubCommit } : {}),
    });
  } catch {
    // Attribution/config only; the proto provider below is authoritative.
  }
}

export function initTracing(config: TracerootPiConfig): Tracing {
  bestEffortSdkInit(config);

  const exporter = new OTLPTraceExporter({
    url: config.otlpEndpoint,
    headers: { Authorization: `Bearer ${config.token}` },
  });

  const resourceAttrs: Record<string, string> = {
    "service.name": config.serviceName,
    "deployment.environment": config.environment,
    "traceroot.project": config.project,
  };
  if (config.githubOwner) resourceAttrs["traceroot.github_owner"] = config.githubOwner;
  if (config.githubRepo) resourceAttrs["traceroot.github_repo_name"] = config.githubRepo;
  if (config.githubCommit) resourceAttrs["traceroot.github_commit_hash"] = config.githubCommit;

  const provider = new NodeTracerProvider({
    resource: new Resource(resourceAttrs),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  return { tracer: provider.getTracer(TRACER_NAME), provider };
}
