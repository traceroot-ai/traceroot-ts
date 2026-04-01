// src/processor.ts
import { Context, Span } from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  ReadableSpan,
  SimpleSpanProcessor,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

export const SDK_NAME = 'traceroot-ts';
export const SDK_VERSION = version;

export interface TraceRootSpanProcessorOptions {
  environment?: string;
  gitRepo?: string;
  gitRef?: string;
}

/**
 * Wraps an inner SpanProcessor (Batch or Simple) and injects TraceRoot SDK
 * metadata attributes on every span start. This is the only processor TraceRoot
 * registers; the inner processor handles actual export batching.
 */
export class TraceRootSpanProcessor implements SpanProcessor {
  private readonly inner: BatchSpanProcessor | SimpleSpanProcessor;
  private readonly _environment: string | undefined;
  private readonly _gitRepo: string | undefined;
  private readonly _gitRef: string | undefined;

  constructor(
    inner: BatchSpanProcessor | SimpleSpanProcessor,
    opts: TraceRootSpanProcessorOptions = {},
  ) {
    this.inner = inner;
    this._environment = opts.environment;
    this._gitRepo = opts.gitRepo;
    this._gitRef = opts.gitRef;
  }

  onStart(span: Span, parentContext: Context): void {
    span.setAttributes({
      'traceroot.sdk.name': SDK_NAME,
      'traceroot.sdk.version': SDK_VERSION,
    });
    if (this._environment !== undefined) {
      span.setAttribute('deployment.environment', this._environment);
    }
    if (this._gitRepo !== undefined) {
      span.setAttribute('traceroot.git.repo', this._gitRepo);
    }
    if (this._gitRef !== undefined) {
      span.setAttribute('traceroot.git.ref', this._gitRef);
    }
    // Cast required: inner processor expects the internal sdk-trace-base Span,
    // but the SpanProcessor interface uses the public @opentelemetry/api Span.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.inner.onStart(span as any, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
