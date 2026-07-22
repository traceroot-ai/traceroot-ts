// Regression tests pinning that public mode (apiKey/Bearer, the default customer
// path) is provably untouched by the multi-project internal-export machinery: no
// traceroot.project_id attribute, no drops from the internal-mode-only drop-guard,
// and the pre-existing per-span enrichment (sdk identity + name/id ancestry paths)
// still lands. Public mode never calls _setInternalMode(true) and never passes
// dropSpansWithoutProjectId — both stay off by default, which is exactly the
// contract under test.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { TraceRootSpanProcessor } from '../src/processor';
import { ContextIdGenerator } from '../src/trace-id';
import { PROJECT_ID_ATTR } from '../src/project-id';
import { _resetSpansState, startSpan } from '../src/spans';
import { observe } from '../src/observe';

/**
 * Register an in-memory pipeline mirroring initialize()'s stack, without any real
 * initialize() call and WITHOUT flipping internal mode: this is the public-mode
 * shape (no _setInternalMode(true), no dropSpansWithoutProjectId).
 */
function registerHarness(): {
  exporter: InMemorySpanExporter;
  provider: NodeTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ idGenerator: new ContextIdGenerator() });
  provider.addSpanProcessor(
    new TraceRootSpanProcessor(new SimpleSpanProcessor(exporter), {
      environment: 'prod',
      globalAttributes: { 'traceroot.source': 'detector' },
    }),
  );
  provider.register();
  return { exporter, provider };
}

async function teardownHarness(provider: NodeTracerProvider): Promise<void> {
  await provider.shutdown();
  _resetForTesting();
  _resetSpansState();
  trace.disable();
  context.disable();
  propagation.disable();
}

describe('public mode: observe() carries no project attribution', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness());
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('observe() spans carry no traceroot.project_id and are all exported', async () => {
    await observe({ name: 'root-run' }, async () => {
      // Third-party auto-instrumentation stand-in, started in the active context
      // like the multi-project suite's plain-OTel-span case.
      const plain = trace.getTracer('third-party').startSpan('auto-instr');
      plain.end();
      return observe({ name: 'child-llm', type: 'llm' }, async () => 'verdict');
    });

    const spans = exporter.getFinishedSpans();
    // Nothing dropped: root + auto-instr + child all arrived.
    assert.equal(spans.length, 3);
    for (const s of spans) {
      assert.equal(s.attributes[PROJECT_ID_ATTR], undefined, `span ${s.name} was attributed`);
    }
  });
});

describe('public mode: startSpan()/child handles export normally', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness());
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('root + child handle export without project attributes', () => {
    const root = startSpan({ name: 'run' });
    const child = root.startSpan({ name: 'judge' });
    child.end();
    root.end();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    const rootSpan = spans.find((s) => s.name === 'run');
    const childSpan = spans.find((s) => s.name === 'judge');
    assert.ok(rootSpan && childSpan);
    assert.equal(rootSpan.attributes[PROJECT_ID_ATTR], undefined);
    assert.equal(childSpan.attributes[PROJECT_ID_ATTR], undefined);
    assert.equal(childSpan.parentSpanId, rootSpan.spanContext().spanId);
  });
});

describe('public mode: the internal-mode-only drop-guard is inert', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness());
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('stray spans with no attribution at all are never dropped', () => {
    const stray = trace.getTracer('bg').startSpan('stray');
    stray.end();
    const stray2 = trace.getTracer('bg').startSpan('stray-2');
    stray2.end();

    const spans = exporter.getFinishedSpans();
    assert.deepEqual(spans.map((s) => s.name).sort(), ['stray', 'stray-2']);
  });
});

describe('public mode: existing span enrichment is intact', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  before(() => {
    ({ exporter, provider } = registerHarness());
  });
  afterEach(() => {
    exporter.reset();
  });
  after(async () => {
    await teardownHarness(provider);
  });

  it('a root span still carries sdk identity and name/id ancestry paths', () => {
    const root = startSpan({ name: 'run' });
    root.end();
    const [s] = exporter.getFinishedSpans();
    assert.equal(s.attributes['traceroot.sdk.name'], 'traceroot-ts');
    assert.ok(typeof s.attributes['traceroot.sdk.version'] === 'string');
    assert.deepEqual(s.attributes['traceroot.span.path'], ['run']);
    assert.deepEqual(s.attributes['traceroot.span.ids_path'], []);
  });
});

// --- Wire-level: real TraceRoot.initialize() against a capture server -------------

// The OTLP protobuf request decoder is not exported by the exporter package;
// reach the transformer's generated root through the exporter's own module
// resolution (test-only — production code never touches these internals). Copied
// locally rather than exported from internal-export-wire.test.ts to keep each
// wire-level test file self-contained.
const exporterRequire = createRequire(
  createRequire(__filename).resolve('@opentelemetry/exporter-trace-otlp-proto'),
);
const transformerRequire = createRequire(
  exporterRequire.resolve('@opentelemetry/otlp-transformer'),
);
const protoRoot = transformerRequire('@opentelemetry/otlp-transformer/build/src/generated/root');
const ExportTraceServiceRequest =
  protoRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

interface ProtoAttribute {
  key: string;
  value: { stringValue?: string };
}
interface ProtoSpan {
  name: string;
  traceId: Uint8Array;
  parentSpanId?: Uint8Array;
  attributes?: ProtoAttribute[];
}
interface DecodedRequest {
  resourceSpans: { scopeSpans?: { spans?: ProtoSpan[] }[] }[];
}

function stringAttr(span: ProtoSpan, key: string): string | undefined {
  return span.attributes?.find((a) => a.key === key)?.value?.stringValue;
}

interface CapturedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Start a local capture server responding with `statusCode` to every request. */
function startCaptureServer(statusCode: number): Promise<{
  port: number;
  server: http.Server;
  nextRequest: () => Promise<CapturedRequest>;
}> {
  let waiter: ((c: CapturedRequest) => void) | undefined;
  const pending: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captured = { url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      if (waiter) {
        waiter(captured);
        waiter = undefined;
      } else {
        pending.push(captured);
      }
      res.statusCode = statusCode;
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        port,
        server,
        // Rejects after 5s so a silent-no-export regression fails loudly
        // instead of hanging the suite (node:test has no default timeout).
        nextRequest: () =>
          pending.length > 0
            ? Promise.resolve(pending.shift() as CapturedRequest)
            : new Promise<CapturedRequest>((resolveReq, reject) => {
                waiter = resolveReq;
                const timer = setTimeout(
                  () => reject(new Error('no export request arrived within 5s')),
                  5000,
                );
                timer.unref();
              }),
      });
    });
  });
}

describe('public wire contract', () => {
  it('Bearer auth, public route, no project header, no project attribute', async () => {
    const { port, server, nextRequest } = await startCaptureServer(200);
    const { mock } = await import('node:test');
    // A caller-supplied projectId in public mode triggers the warn-once path in
    // project-id.ts — capture/mock it so test output stays clean.
    const warn = mock.method(console, 'warn', () => {});
    try {
      TraceRoot.initialize({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
      });
      const root = startSpan({ name: 'run' });
      root.end();
      await TraceRoot.flush();

      const req = await nextRequest();
      assert.equal(req.url, '/api/v1/public/traces');
      assert.equal(req.headers['authorization'], 'Bearer test-key');
      assert.equal(Object.prototype.hasOwnProperty.call(req.headers, 'x-project-id'), false);

      const decoded = ExportTraceServiceRequest.decode(
        gunzipSync(req.body),
      ) as unknown as DecodedRequest;
      const spans = decoded.resourceSpans.flatMap((rs) =>
        (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
      );
      const run = spans.find((s) => s.name === 'run');
      assert.ok(run, 'exported request contains the root span');
      assert.equal(stringAttr(run, 'traceroot.project_id'), undefined);

      // Public gating end-to-end on the wire: a caller-supplied projectId is
      // ignored (warned once), and the span still exports with no attribute.
      const gated = startSpan({ name: 'gated-run', projectId: 'proj-1' });
      gated.end();
      await TraceRoot.flush();

      const req2 = await nextRequest();
      const decoded2 = ExportTraceServiceRequest.decode(
        gunzipSync(req2.body),
      ) as unknown as DecodedRequest;
      const spans2 = decoded2.resourceSpans.flatMap((rs) =>
        (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
      );
      const gatedSpan = spans2.find((s) => s.name === 'gated-run');
      assert.ok(gatedSpan, 'gated span still exported');
      assert.equal(stringAttr(gatedSpan, 'traceroot.project_id'), undefined);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      warn.mock.restore();
      // Shut the provider down (flushing may fail against the closing server — ignore)
      // so no batch timer holds buffered spans aimed at a closed port.
      await TraceRoot.shutdown().catch(() => {});
      _resetForTesting();
      _resetSpansState(); // drop the cached module tracer so the next test re-resolves it
      server.close();
      server.closeAllConnections?.();
    }
  });
});
