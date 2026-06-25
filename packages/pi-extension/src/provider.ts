// Tracing provider wiring.
//
// The OTLP/proto exporter + BatchSpanProcessor are the single source of truth for
// export. Spans are sent directly over OTLP; there is no separate SDK dependency.
import { type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { TracerootPiConfig } from "./config.ts";

export interface Tracing {
  tracer: Tracer;
  provider: NodeTracerProvider;
}

const TRACER_NAME = "traceroot-pi-extension";

export function initTracing(config: TracerootPiConfig): Tracing {
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
