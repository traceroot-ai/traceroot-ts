// src/processor.ts
import { Context, Span } from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  ReadableSpan,
  SimpleSpanProcessor,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

export const SDK_NAME = 'traceroot-ts';
export const SDK_VERSION = '0.1.0';

/**
 * Wraps an inner SpanProcessor (Batch or Simple) and injects TraceRoot SDK
 * metadata attributes on every span start. This is the only processor TraceRoot
 * registers; the inner processor handles actual export batching.
 */
export class TraceRootSpanProcessor implements SpanProcessor {
  private readonly inner: BatchSpanProcessor | SimpleSpanProcessor;

  constructor(inner: BatchSpanProcessor | SimpleSpanProcessor) {
    this.inner = inner;
  }

  onStart(span: Span, parentContext: Context): void {
    span.setAttributes({
      'traceroot.sdk.name': SDK_NAME,
      'traceroot.sdk.version': SDK_VERSION,
    });
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
