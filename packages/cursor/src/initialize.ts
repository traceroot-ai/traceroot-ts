import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { Tracer } from '@opentelemetry/api';

const TRACER_NAME = '@traceroot-ai/cursor';
const TRACER_VERSION = '0.0.1';
const SDK_NAME = 'traceroot-cursor';

const DEFAULT_BASE_URL = 'https://app.traceroot.ai';

export interface InitializeOptions {
  apiKey: string;
  baseUrl?: string;
  disableBatch?: boolean;
}

export interface CursorTracingHandle {
  readonly tracer: Tracer;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

let handle: CursorTracingHandle | undefined;
let provider: BasicTracerProvider | undefined;

export function initialize(options: InitializeOptions): CursorTracingHandle {
  if (handle) return handle;

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const headers: Record<string, string> = {
    'x-traceroot-sdk-name': SDK_NAME,
    'x-traceroot-sdk-version': TRACER_VERSION,
    Authorization: `Bearer ${options.apiKey}`,
  };

  const exporter = new OTLPTraceExporter({
    url: `${baseUrl}/api/v1/public/traces`,
    headers,
  });

  const processor: SpanProcessor = options.disableBatch
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);

  const localProvider = new BasicTracerProvider({
    spanProcessors: [processor],
  });
  provider = localProvider;

  const newHandle: CursorTracingHandle = {
    tracer: localProvider.getTracer(TRACER_NAME, TRACER_VERSION),
    async flush() {
      await localProvider.forceFlush();
    },
    async shutdown() {
      await localProvider.shutdown();
      if (handle === newHandle) handle = undefined;
      if (provider === localProvider) provider = undefined;
    },
  };

  handle = newHandle;
  return newHandle;
}

export function getCursorTracer(): Tracer | undefined {
  return handle?.tracer;
}

export async function flush(): Promise<void> {
  if (handle) await handle.flush();
}

export async function shutdown(): Promise<void> {
  if (handle) await handle.shutdown();
}
