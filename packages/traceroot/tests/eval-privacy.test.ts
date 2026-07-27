// Phase 0A: a LOCAL evaluation must never export eval/task/scorer or nested child spans,
// even when TRACEROOT_API_KEY is set. The boundary is enforced where spans are recorded/
// exported (the provider), not merely by hiding the result's traceId.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { startSpan, _resetSpansState } from '../src/spans';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { _resetObserveState } from '../src/observe';
import { _resetEvalTracer } from '../src/eval/tracer';
import { Dataset, evaluate, FakeTransport } from '../src/eval';
import type { ScorerContext } from '../src/eval';

const echo = (x: unknown) => x;
const exact = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);

function ds1(): Dataset {
  const d = new Dataset('d');
  d.upsert({ input: 1, id: 'c0', expected: 1 });
  return d;
}

let prevKey: string | undefined;
let prevHost: string | undefined;
let fetchCalls: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  prevKey = process.env['TRACEROOT_API_KEY'];
  prevHost = process.env['TRACEROOT_HOST_URL'];
  fetchCalls = [];
  // Record any network attempt so we can assert nothing hits the trace endpoint.
  globalThis.fetch = (async (url: unknown, ...rest: unknown[]) => {
    fetchCalls.push(String(url));
    return realFetch(url as string, ...(rest as []));
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (prevKey === undefined) delete process.env['TRACEROOT_API_KEY'];
  else process.env['TRACEROOT_API_KEY'] = prevKey;
  if (prevHost === undefined) delete process.env['TRACEROOT_HOST_URL'];
  else process.env['TRACEROOT_HOST_URL'] = prevHost;
  _resetForTesting();
  _resetObserveState();
  _resetSpansState();
  _resetEvalTracer();
});

describe('Phase 0A — local eval never exports, even with credentials', () => {
  it('credentialed local run + nested instrumented span never initializes the exporter', async () => {
    // Credentials present in the environment — the exact condition that used to make TS
    // export local eval spans. No global provider is registered by the app here.
    process.env['TRACEROOT_API_KEY'] = 'tr-secret-key';
    process.env['TRACEROOT_HOST_URL'] = 'https://app.traceroot.ai';
    _resetForTesting();
    _resetSpansState();
    _resetEvalTracer();

    // Spy: count global-provider initializations. If this stays 0, no OTLP exporter is
    // ever constructed, so zero requests can reach the trace endpoint — a structural proof.
    const realInit = TraceRoot.initialize;
    let initCalls = 0;
    (TraceRoot as unknown as { initialize: () => void }).initialize = () => {
      initCalls += 1;
      return realInit.call(TraceRoot);
    };

    let nestedRan = false;
    const taskWithInstrumentedChild = (x: unknown) => {
      // A nested "instrumented" child span via the public API — the vector that would
      // otherwise lazily bring up the global exporting provider.
      const child = startSpan({ name: 'nested-llm', type: 'llm', input: x });
      nestedRan = true;
      child.end();
      return x;
    };

    try {
      const result = await evaluate({
        name: 'r',
        dataset: ds1(),
        task: taskWithInstrumentedChild,
        scorers: [exact],
        local: true,
      });

      assert.equal(nestedRan, true, 'nested child span must have executed');
      // The core proof: the exporting provider was never initialized.
      assert.equal(initCalls, 0, 'local eval must not initialize the exporting provider');
      assert.equal(TraceRoot.isInitialized(), false);
      // No request reached the trace endpoint.
      assert.equal(
        fetchCalls.some((u) => u.includes('/traces')),
        false,
        `no /traces request expected; saw: ${fetchCalls.join(', ')}`,
      );
      // Result is honestly local: no platform trace id.
      assert.equal(result.uploadState.status, 'local_only');
      assert.equal(result.itemResults[0].traceId, null);
    } finally {
      (TraceRoot as unknown as { initialize: typeof realInit }).initialize = realInit;
    }
  });

  it('reported run still records/exports eval spans (preserved behavior)', async () => {
    // A globally-registered provider stands in for the app's tracing. No credentials, so
    // nothing initializes TraceRoot; a trace-reporting transport routes spans to it.
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
    try {
      const result = await evaluate({
        name: 'r',
        dataset: ds1(),
        task: echo,
        scorers: [exact],
        transport: new FakeTransport(true),
      });
      const names = exporter
        .getFinishedSpans()
        .map((s: ReadableSpan) => s.name)
        .sort();
      assert.deepEqual(names, ['evaluation-item', 'exact', 'task']);
      // Reported run carries a real platform trace id.
      assert.notEqual(result.itemResults[0].traceId, null);
    } finally {
      await provider.shutdown();
    }
  });
});
