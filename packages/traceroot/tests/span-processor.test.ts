import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { SDK_NAME } from '../src/processor';

// The shape Temporal's makeWorkflowExporter hands to SpanProcessor.onEnd: a plain object
// rebuilt from a span the workflow sandbox serialized, never seen by onStart.
function workflowSpan(attributes: Record<string, string> = {}): ReadableSpan {
  const spanContext = {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: TraceFlags.SAMPLED,
  };
  return {
    spanContext: () => spanContext,
    name: 'RunWorkflow:agentWorkflow',
    kind: SpanKind.INTERNAL,
    parentSpanId: '00f067aa0ba902b7',
    startTime: [1, 0],
    endTime: [2, 0],
    duration: [1, 0],
    ended: true,
    status: { code: SpanStatusCode.OK },
    attributes: { run_id: 'run-1', ...attributes },
    links: [],
    events: [],
    resource: new Resource({ 'service.name': 'my-agent' }),
    instrumentationLibrary: { name: '@temporalio/interceptor-workflow' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

describe('TraceRoot.spanProcessor()', () => {
  let seen: ReadableSpan[] = [];
  afterEach(() => {
    _resetForTesting();
    seen = [];
  });

  function init(options: Parameters<typeof TraceRoot.initialize>[0] = {}): void {
    TraceRoot.initialize({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:9',
      disableBatch: true,
      instrumentModules: {},
      exportSpan: (span) => {
        seen.push(span);
        return false; // keep it off the network
      },
      ...options,
    });
  }

  it('passes an ended span through exportSpan with the attributes onStart would have set', () => {
    init({
      environment: 'staging',
      gitRepo: 'acme/agent',
      gitRef: 'abc123',
      globalAttributes: { team: 'search' },
    });
    TraceRoot.spanProcessor().onEnd(workflowSpan());

    assert.equal(seen.length, 1);
    const [span] = seen;
    assert.equal(span.name, 'RunWorkflow:agentWorkflow');
    assert.equal(span.spanContext().spanId, 'b7ad6b7169203331');
    assert.equal(span.parentSpanId, '00f067aa0ba902b7');
    assert.deepEqual(
      {
        sdk: span.attributes['traceroot.sdk.name'],
        env: span.attributes['traceroot.environment'],
        repo: span.attributes['traceroot.git.repo'],
        ref: span.attributes['traceroot.git.ref'],
        team: span.attributes['team'],
        runId: span.attributes['run_id'],
      },
      {
        sdk: SDK_NAME,
        env: 'staging',
        repo: 'acme/agent',
        ref: 'abc123',
        team: 'search',
        runId: 'run-1',
      },
    );
  });

  it("keeps the span's own attribute over a global with the same key", () => {
    init({ globalAttributes: { team: 'search' } });
    TraceRoot.spanProcessor().onEnd(workflowSpan({ team: 'billing' }));
    assert.equal(seen[0].attributes['team'], 'billing');
  });

  it("drops the workflow info fields Temporal's sink copies in that hold user payloads (#183)", () => {
    init();
    const payloads = {
      memo: 'm',
      searchAttributes: 's',
      typedSearchAttributes: 't',
      lastResult: 'r',
      lastFailure: 'f',
    };
    TraceRoot.spanProcessor().onEnd(workflowSpan({ workflowId: 'wf-1', ...payloads }));
    const { attributes } = seen[0];
    assert.equal(attributes['workflowId'], 'wf-1');
    for (const key of Object.keys(payloads)) assert.equal(attributes[key], undefined, key);
  });

  it('does not mutate the span it was handed', () => {
    init({ globalAttributes: { team: 'search' } });
    const span = workflowSpan();
    TraceRoot.spanProcessor().onEnd(span);
    assert.deepEqual(span.attributes, { run_id: 'run-1' });
  });

  it('drops spans while TraceRoot is not initialized', async () => {
    assert.doesNotThrow(() => TraceRoot.spanProcessor().onEnd(workflowSpan()));
    init();
    await TraceRoot.shutdown();
    TraceRoot.spanProcessor().onEnd(workflowSpan());
    assert.equal(seen.length, 0);
  });

  it('drops spans after _clearCredentials() (local-only eval runs)', () => {
    init();
    TraceRoot._clearCredentials();
    TraceRoot.spanProcessor().onEnd(workflowSpan());
    assert.equal(seen.length, 0);
  });

  it('drops spans when tracing is disabled', () => {
    init({ enabled: false });
    TraceRoot.spanProcessor().onEnd(workflowSpan());
    assert.equal(seen.length, 0);
  });

  it('works when taken before initialize()', () => {
    const processor = TraceRoot.spanProcessor();
    init();
    processor.onEnd(workflowSpan());
    assert.equal(seen.length, 1);
  });

  it('leaves TraceRoot initialized when shut down', async () => {
    init();
    await TraceRoot.spanProcessor().shutdown();
    assert.equal(TraceRoot.isInitialized(), true);
    TraceRoot.spanProcessor().onEnd(workflowSpan());
    assert.equal(seen.length, 1);
  });
});
