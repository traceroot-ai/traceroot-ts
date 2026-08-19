// truthful local/cloud boundary. A local-only (non-reporting) runner run drops
// credentials (mirroring traceroot-py) so it can never silently upload eval results on
// ambient credentials, and makes zero network calls. Parity with the Python local-only tests.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace, type Span } from '@opentelemetry/api';

import { Dataset, Emitter, evaluate, runSuite } from '../src/eval';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { _isGlobalAutoInitSuppressed } from '../src/spans';
import { TraceRootSpanProcessor, _resetProcessorState } from '../src/processor';

const realFetch = globalThis.fetch;
const evalDir = join(__dirname, '..', 'src', 'eval').replace(/\\/g, '/');

beforeEach(() => {
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_ENABLED'];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['TRACEROOT_API_KEY'];
  delete process.env['TRACEROOT_ENABLED'];
});

describe('local-only network boundary', () => {
  it('_clearCredentials drops resolved credentials (no reporting transport can be built)', () => {
    process.env['TRACEROOT_API_KEY'] = 'tr-x';
    assert.notEqual(TraceRoot.resolveCredentials().apiKey, '');
    delete process.env['TRACEROOT_API_KEY'];
    TraceRoot._clearCredentials();
    assert.equal(TraceRoot.resolveCredentials().apiKey, '');
  });

  it('a local (non-reporting) run makes zero network calls even with ambient credentials', async () => {
    process.env['TRACEROOT_API_KEY'] = 'tr-ambient';
    let fetchCalls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls += 1;
      return (realFetch as any)(...args);
    }) as any;

    const dir = mkdtempSync(join(tmpdir(), 'localonly-'));
    const evalFile = join(dir, 'routing_eval.ts');
    writeFileSync(
      evalFile,
      `import { Dataset, Evaluation, FakeTransport } from '${evalDir}';
       const ds = new Dataset('t');
       ds.add({ m: 'charge' }, { id: 'a', expected: { r: 'billing' } });
       function task(x: any) { return { r: 'billing' }; }
       function acc(ctx: any) { return 1; }
       export const e = new Evaluation({ name: 'e', dataset: ds, task, scorers: [acc], transport: new FakeTransport() });`,
    );

    const events: Record<string, any>[] = [];
    await runSuite(
      [evalFile],
      { reporting: false, no_artifact: true },
      new Emitter((ln) => events.push(JSON.parse(ln))),
    );

    // Enforced local-only: TRACEROOT_ENABLED is off AND the ambient API key was dropped.
    assert.equal(fetchCalls, 0);
    assert.equal(process.env['TRACEROOT_ENABLED'], 'false');
    assert.equal(process.env['TRACEROOT_API_KEY'], undefined);
    assert.ok(events.some((e) => e.type === 'evaluation_completed'));
  });
});

describe('local-leak hardening + snapshot runner input', () => {
  it('_clearCredentials keeps the TRACEROOT_HOST_URL fallback (not the hard default host)', () => {
    process.env['TRACEROOT_HOST_URL'] = 'https://self.example.com';
    TraceRoot._clearCredentials();
    assert.equal(TraceRoot.resolveCredentials().baseUrl, 'https://self.example.com');
    delete process.env['TRACEROOT_HOST_URL'];
  });

  it('a local run suppresses global auto-init during the task and releases it afterward', async () => {
    let suppressedDuringTask = false;
    const ds = new Dataset('supp');
    ds.add({ q: 1 }, { id: 'a' });
    await evaluate({
      name: 'supp',
      dataset: ds,
      local: true,
      task: () => {
        suppressedDuringTask = _isGlobalAutoInitSuppressed();
        return { r: 1 };
      },
      scorers: [() => 1],
    });
    assert.equal(suppressedDuringTask, true, 'suppression active during a local task');
    assert.equal(_isGlobalAutoInitSuppressed(), false, 'suppression released after the run');
  });

  it('the runner runs an Evaluation whose dataset is a DatasetSnapshot (no caseIds crash)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snaprun-'));
    const evalFile = join(dir, 'snap_eval.ts');
    writeFileSync(
      evalFile,
      `import { Dataset, Evaluation } from '${evalDir}';
       const ds = new Dataset('snap', null, { key: 'snap' });
       ds.add({ m: 'a' }, { id: 'a', expected: 1 });
       ds.add({ m: 'b' }, { id: 'b', expected: 2 });
       export const e = new Evaluation({ name: 'snap', dataset: ds.snapshot(), task: (x: any) => x.m, scorers: [() => 1] });`,
    );
    const events: Record<string, any>[] = [];
    await runSuite(
      [evalFile],
      { reporting: false, no_artifact: true },
      new Emitter((ln) => events.push(JSON.parse(ln))),
    );
    const started = events.find((e) => e.type === 'evaluation_started');
    assert.equal(started?.dataset?.case_count, 2, 'snapshot cases counted, not crashed on');
    assert.ok(events.some((e) => e.type === 'evaluation_completed'));
  });
});

// Measures at the EXPORTER boundary, not at span creation. After the app has already
// initialized tracing, we spy the inner (exporting) processor's onEnd on the registered
// TraceRootSpanProcessor and record which span names it would hand off. The spy does NOT
// forward to the real OTLP exporter, so the test stays offline even if a span leaks.
describe('local: true export suppression at the exporter boundary', () => {
  // Records the names the inner exporter would receive, and returns them. Replaces
  // inner.onEnd with a non-forwarding recorder so no network export can happen.
  function spyExporterAfterInit(): string[] {
    TraceRoot.initialize({
      apiKey: 'dummy-key',
      baseUrl: 'http://127.0.0.1:9', // unroutable; guards against a real background export
      disableBatch: true,
      instrumentModules: {}, // no auto-instrumentation; we create the app span by hand
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gp = trace.getTracerProvider() as any;
    const delegate = typeof gp.getDelegate === 'function' ? gp.getDelegate() : gp;
    const registered = delegate._registeredSpanProcessors as unknown[];
    const proc = registered.find((p) => p instanceof TraceRootSpanProcessor) as
      | TraceRootSpanProcessor
      | undefined;
    assert.ok(proc, 'a TraceRootSpanProcessor should be registered after initialize()');
    const exported: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proc as any).inner.onEnd = (span: { name: string }) => {
      exported.push(span.name);
    };
    return exported;
  }

  beforeEach(() => {
    // Never let a real background export reject and crash the run (defense in depth:
    // the spy above already blocks forwarding).
    process.on('unhandledRejection', () => {});
  });
  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    _resetForTesting();
    _resetProcessorState();
  });

  it('a local: true run forwards NOTHING from an already-initialized provider to the exporter', async () => {
    const exported = spyExporterAfterInit();
    const ds = new Dataset('leak');
    ds.add({ q: 1 }, { id: 'a' });
    await evaluate({
      name: 'leak',
      dataset: ds,
      local: true,
      // An app / auto-instrumentation span created through the GLOBAL exporting provider during
      // the run. Under context.with(suppressTracing(...)) it is created non-recording, so it
      // never reaches the processor's onEnd at all — the spy records nothing.
      task: () => {
        trace.getTracer('app').startSpan('messages.create').end();
        return { r: 1 };
      },
      scorers: [() => 1],
    });
    assert.deepEqual(exported, [], 'no span reached the exporter during a local run');
  });

  it('a concurrent span on a different (un-suppressed) context still exports during a local run', async () => {
    const exported = spyExporterAfterInit();
    // Hold the local run open mid-flight so an unrelated span can be created WHILE it runs, but
    // on the test's own context — which never entered the suppressed context. Origin scoping (not
    // the old process-global gate) means that span must still export. This is the case #1969 filed.
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((r) => {
      releaseTask = r;
    });
    let signalStarted!: () => void;
    const taskStarted = new Promise<void>((r) => {
      signalStarted = r;
    });
    const ds = new Dataset('concurrent');
    ds.add({ q: 1 }, { id: 'a' });
    const runPromise = evaluate({
      name: 'concurrent',
      dataset: ds,
      local: true,
      task: async () => {
        signalStarted(); // the run is now mid-flight, holding its suppressed context
        await taskGate;
        return { r: 1 };
      },
      scorers: [() => 1],
    });
    await taskStarted;
    // Created + ended on the test's own (un-suppressed) context, concurrent with the live run.
    trace.getTracer('other').startSpan('unrelated.work').end();
    releaseTask();
    await runPromise;
    assert.deepEqual(
      exported,
      ['unrelated.work'],
      'a concurrent span outside the run still exports',
    );
  });

  it('a span created inside the suppressed run is non-recording — a late .end() never forwards', async () => {
    const exported = spyExporterAfterInit();
    // Captured inside the run (under suppression) but NOT ended there; ended after the run
    // returns and its context is gone. It was created non-recording, so onEnd never fires at the
    // processor even when .end() runs later — the leak the origin-scoped gate closes for real.
    let lateSpan: Span | undefined;
    const ds = new Dataset('late');
    ds.add({ q: 1 }, { id: 'a' });
    await evaluate({
      name: 'late',
      dataset: ds,
      local: true,
      task: () => {
        lateSpan = trace.getTracer('app').startSpan('late.work');
        return { r: 1 };
      },
      scorers: [() => 1],
    });
    lateSpan?.end();
    assert.deepEqual(
      exported,
      [],
      'a late-ended span from a suppressed run never reaches the exporter',
    );
  });
});
