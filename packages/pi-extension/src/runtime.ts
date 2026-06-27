// Shared runtime handed to every handler registration. One object, passed by
// reference, so a config finalize (project-local merge) is visible to all handlers
// that read rt.config at call time.
import type { Tracer } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ConfigIssue, TracerootPiConfig } from './config.ts';
import type { SpanState } from './state.ts';
import type { ExtensionAPI } from './types.ts';

export interface Runtime {
  pi: ExtensionAPI;
  config: TracerootPiConfig;
  envProvided: Set<keyof TracerootPiConfig>;
  configIssues: ConfigIssue[];
  tracer: Tracer;
  provider: NodeTracerProvider;
  state: SpanState;
  debug: (...args: unknown[]) => void;
}
