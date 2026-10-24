import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TraceRoot, _resetForTesting } from '../src/traceroot';

// Fake ingest endpoint: counts non-empty OTLP export requests.
let server: Server;
let baseUrl: string;
let exports = 0;

before(async () => {
  server = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => (bytes += chunk.length));
    req.on('end', () => {
      if (req.url?.endsWith('/api/v1/public/traces') && bytes > 0) exports++;
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

/**
 * Run a long-lived app that ends spans (held by the batch processor, whose 5s delay
 * has not elapsed), then stop it with `signal` and report how it exited.
 */
async function runAndSignal(
  signal: NodeJS.Signals,
  { initOptions = '', appSetup = '' } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; exports: number }> {
  exports = 0;
  const pkgDir = process.cwd();
  const tsxLoader = pathToFileURL(
    path.join(pkgDir, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  ).href;
  const script = `
    const { initialize, startSpan } = require('./src/index.ts');
    ${appSetup}
    initialize({ apiKey: 'test-key', baseUrl: ${JSON.stringify(baseUrl)}, ${initOptions} });
    for (let i = 0; i < 3; i++) startSpan({ name: 'work-' + i }).end();
    setInterval(() => {}, 1000);
    console.log('ready');
  `;
  const child = spawn(process.execPath, ['--import', tsxLoader, '-e', script], {
    cwd: pkgDir,
    env: { ...process.env, TRACEROOT_GIT_REPO: 'test/repo', TRACEROOT_GIT_REF: 'test' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve();
    });
    child.once('exit', () => reject(new Error(`child exited before ready: ${stderr}`)));
  });
  child.kill(signal);
  const [code, exitSignal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once('exit', (c, s) => resolve([c, s])),
  );
  return { code, signal: exitSignal, exports };
}

describe('flush on SIGTERM/SIGINT', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`exports buffered spans on ${signal}, then exits by the signal`, async () => {
      const result = await runAndSignal(signal);
      assert.equal(result.exports, 1);
      assert.equal(result.signal, signal);
    });
  }

  it("flushes but leaves exiting to the app's own handler", async () => {
    const result = await runAndSignal('SIGTERM', {
      appSetup: `process.on('SIGTERM', () => setTimeout(() => process.exit(7), 1000));`,
    });
    assert.equal(result.exports, 1);
    assert.equal(result.code, 7);
  });

  it('honors a one-shot app handler registered before initialize()', async () => {
    // A `once` listener ahead of ours removes itself before ours runs, so a listener
    // count read inside our handler would miss it and kill the process mid-shutdown.
    const result = await runAndSignal('SIGTERM', {
      appSetup: `process.once('SIGTERM', () => setTimeout(() => process.exit(7), 1000));`,
    });
    assert.equal(result.exports, 1);
    assert.equal(result.code, 7);
  });

  it('does not install signal handlers when flushOnSignal is false', async () => {
    const result = await runAndSignal('SIGTERM', { initOptions: 'flushOnSignal: false' });
    assert.equal(result.exports, 0);
    assert.equal(result.signal, 'SIGTERM');
  });
});

describe('exit-hook listeners', () => {
  afterEach(() => {
    _resetForTesting();
  });

  it('shutdown() removes every listener initialize() added', async () => {
    const events = ['beforeExit', 'SIGTERM', 'SIGINT'] as const;
    const counts = () => events.map((e) => process.listenerCount(e));
    const baseline = counts();
    for (let i = 0; i < 3; i++) {
      TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true });
      assert.deepEqual(
        counts(),
        baseline.map((n) => n + 1),
      );
      await TraceRoot.shutdown();
      assert.deepEqual(counts(), baseline);
    }
  });
});
