import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { context, propagation, trace } from '@opentelemetry/api';
import { TraceRootSpanProcessor, SDK_VERSION } from '../src/processor';

describe('TraceRootSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const inner = new SimpleSpanProcessor(exporter);
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new TraceRootSpanProcessor(inner));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    // Reset global OTel state so each test gets a clean slate
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('injects traceroot.sdk.name on every span', async () => {
    const tracer = trace.getTracer('test');
    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('test-span', (span) => {
        span.end();
        resolve();
      });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.sdk.name'], 'traceroot-ts');
  });

  it('injects traceroot.sdk.version on every span', async () => {
    const tracer = trace.getTracer('test');
    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('test-span', (span) => {
        span.end();
        resolve();
      });
    });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.attributes['traceroot.sdk.version'], SDK_VERSION);
  });

  it('still exports the span through the inner processor', async () => {
    const tracer = trace.getTracer('test');
    await new Promise<void>((resolve) => {
      tracer.startActiveSpan('test-span', (span) => {
        span.end();
        resolve();
      });
    });
    assert.equal(exporter.getFinishedSpans().length, 1);
  });
});
