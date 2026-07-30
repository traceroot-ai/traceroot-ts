// Wire-level contract tests for internal export mode: what actually leaves the
// process over HTTP. The resolved-target unit tests once passed while the real
// request was broken (the OTLP exporter strips query strings from its endpoint
// URL), so these assert on a captured request instead of derived strings.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { startSpan, _resetSpansState } from '../src/spans';
import { isInternalMode } from '../src/trace-id';

const FORCED = 'feedfacefeedfacefeedfacefeedface';

// The OTLP protobuf request decoder is not exported by the exporter package;
// reach the transformer's generated root through the exporter's own module
// resolution (test-only — production code never touches these internals).
const exporterRequire = createRequire(
  createRequire(__filename).resolve('@opentelemetry/exporter-trace-otlp-proto'),
);
const transformerRequire = createRequire(
  exporterRequire.resolve('@opentelemetry/otlp-transformer'),
);
const protoRoot = transformerRequire('@opentelemetry/otlp-transformer/build/src/generated/root');
const ExportTraceServiceRequest =
  protoRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

interface ProtoSpan {
  name: string;
  traceId: Uint8Array;
  parentSpanId?: Uint8Array;
}
interface DecodedRequest {
  resourceSpans: { scopeSpans?: { spans?: ProtoSpan[] }[] }[];
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

describe('internal export wire contract', () => {
  it('sends the bare path, X-Project-Id + custom headers, and a decodable forced-root body', async () => {
    const { port, server, nextRequest } = await startCaptureServer(200);
    try {
      TraceRoot.initialize({
        baseUrl: `http://127.0.0.1:${port}`,
        internalExport: {
          path: '/api/v1/internal/traces',
          projectId: 'proj-wire',
          headers: { 'X-Internal-Secret': 'sekrit' },
        },
      });
      const root = startSpan({ name: 'run', traceId: FORCED });
      root.end();
      await TraceRoot.flush();

      const req = await nextRequest();
      assert.equal(req.url, '/api/v1/internal/traces', 'exact path, no query string');
      assert.equal(req.headers['x-project-id'], 'proj-wire');
      assert.equal(req.headers['x-internal-secret'], 'sekrit');
      assert.equal(Object.prototype.hasOwnProperty.call(req.headers, 'authorization'), false);

      assert.equal(
        req.headers['content-encoding'],
        'gzip',
        'gzip compression is part of the contract',
      );
      const decoded = ExportTraceServiceRequest.decode(
        gunzipSync(req.body),
      ) as unknown as DecodedRequest;
      const spans = decoded.resourceSpans.flatMap((rs) =>
        (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
      );
      const run = spans.find((s) => s.name === 'run');
      assert.ok(run, 'exported request contains the root span');
      assert.equal(Buffer.from(run.traceId).toString('hex'), FORCED);
      assert.equal(
        (run.parentSpanId ?? new Uint8Array()).length,
        0,
        'forced root has no parent on the wire',
      );
    } finally {
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

describe('flush() failure contract', () => {
  it('rejects when the ingest route denies the export, leaving the process unharmed', async () => {
    const { port, server } = await startCaptureServer(403);
    try {
      TraceRoot.initialize({
        baseUrl: `http://127.0.0.1:${port}`,
        internalExport: {
          path: '/api/v1/internal/traces',
          projectId: 'p',
          headers: { 'X-Internal-Secret': 'wrong' },
        },
      });
      const root = startSpan({ name: 'denied', traceId: FORCED });
      root.end();
      // The SDK does not swallow export failures — the consumer decides.
      await assert.rejects(TraceRoot.flush());
      // The process (and tracer) keeps working after the rejection.
      const again = startSpan({ name: 'still-alive' });
      assert.doesNotThrow(() => again.end());
    } finally {
      // Shut the provider down (flushing may fail against the closing server — ignore)
      // so no batch timer holds buffered spans aimed at a closed port.
      await TraceRoot.shutdown().catch(() => {});
      _resetForTesting();
      _resetSpansState(); // drop the cached module tracer so the next test re-resolves it
      server.close();
      server.closeAllConnections?.();
    }
  });

  it('shutdown() rejects but still resets isInitialized()/isInternalMode() state', async () => {
    const { port, server } = await startCaptureServer(403);
    try {
      TraceRoot.initialize({
        baseUrl: `http://127.0.0.1:${port}`,
        internalExport: {
          path: '/api/v1/internal/traces',
          projectId: 'p',
          headers: { 'X-Internal-Secret': 'wrong' },
        },
      });
      const root = startSpan({ name: 'denied', traceId: FORCED });
      root.end();
      // shutdown() flushes on the way out; a denied export makes it reject —
      // the state cleanup below must still happen despite the rejection.
      await assert.rejects(TraceRoot.shutdown());
      assert.equal(TraceRoot.isInitialized(), false);
      assert.equal(isInternalMode(), false);
    } finally {
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
