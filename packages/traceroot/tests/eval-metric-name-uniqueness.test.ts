// Emitted-metric names must be unique within a run. A Score row's identity IS its emitted-metric
// name, and the platform keys that metric's direction/threshold on the name. Two scorers reporting
// the same metric name make the policy ambiguous, so the platform defensively drops the metric to
// non-directional. The SDK catches the static case at config time (fail fast, before the run) and
// warns on the dynamic case (a metric-map scorer whose emitted name is only known once it has run).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { Dataset, evaluate, scorer } from '../src/eval';
import { _resetForTesting } from '../src/traceroot';
import { _resetSpansState } from '../src/spans';

const realFetch = globalThis.fetch;
const realWarn = console.warn;
let provider: NodeTracerProvider;
beforeEach(() => {
  provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()));
  provider.register();
});
afterEach(async () => {
  await provider.shutdown();
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  delete process.env['TRACEROOT_API_KEY'];
  _resetForTesting();
  _resetSpansState();
});

function capture(): Array<{ url: string; body: any }> {
  const calls: Array<{ url: string; body: any }> = [];
  process.env['TRACEROOT_API_KEY'] = 'tr-x';
  globalThis.fetch = (async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/evaluation-runs'))
      return new Response(JSON.stringify({ evaluation_run_id: 'run1' }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  return calls;
}
function captureWarnings(): string[] {
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(' '));
  };
  return warned;
}
function ds() {
  const d = new Dataset('d');
  d.datasetId = 'ds_1';
  d.datasetVersionId = 'v1';
  d.upsert({ input: 'i', id: 'c0', expected: 'e' });
  return d;
}
const complete = (calls: Array<{ url: string; body: any }>) =>
  calls.find((c) => c.url.endsWith('/complete'))!.body;

describe('emitted-metric name uniqueness', () => {
  // --- 1. config-time, fail fast ---

  it('rejects two scorers resolving to the same name before the run starts', async () => {
    const calls = capture();
    const exact = scorer(() => 1.0, { name: 'accuracy', threshold: 0.5 });
    const fuzzy = scorer(() => 0.5, { name: 'accuracy', threshold: 0.9 });
    const ran: unknown[] = [];
    await assert.rejects(
      evaluate({
        name: 'r',
        dataset: ds(),
        task: (x: unknown) => {
          ran.push(x);
          return 'out';
        },
        scorers: [exact, fuzzy],
      }),
      (err: Error) => {
        assert.match(err.message, /'accuracy'/);
        assert.match(err.message, /metric names must be unique within a run/);
        assert.match(err.message, /distinct name \(or key\)/);
        return true;
      },
    );
    // Fail fast: the run never started, so nothing was executed or reported.
    assert.deepEqual(ran, []);
    assert.deepEqual(calls, []);
  });

  it('rejects two undecorated scorers sharing a function name', async () => {
    capture();
    const make = () =>
      function relevance() {
        return 1.0;
      };
    await assert.rejects(
      evaluate({ name: 'r', dataset: ds(), task: () => 'out', scorers: [make(), make()] }),
      /metric names must be unique within a run/,
    );
  });

  it('lists every duplicated name in the error', async () => {
    capture();
    const one = scorer(() => 1.0, { name: 'a' });
    const two = scorer(() => 1.0, { name: 'a' });
    const three = scorer(() => 1.0, { name: 'b' });
    const four = scorer(() => 1.0, { name: 'b' });
    await assert.rejects(
      evaluate({
        name: 'r',
        dataset: ds(),
        task: () => 'out',
        scorers: [one, two, three, four],
      }),
      /'a', 'b'/,
    );
  });

  // --- 2. manifest build, warn (never fail) ---

  it('warns exactly once when a metric map collides with another scorer, and still completes', async () => {
    const calls = capture();
    const warned = captureWarnings();
    // 'quality' is emitted by BOTH: only discoverable after the run, so warn rather than fail.
    const rubric = scorer(() => ({ quality: 0.8, fluency: 0.9 }), {
      name: 'rubric',
      valueType: 'numeric',
      direction: 'higher_is_better',
    });
    const quality = scorer(() => 0.1, {
      name: 'quality',
      valueType: 'numeric',
      direction: 'lower_is_better',
      threshold: 0.2,
    });
    const result = await evaluate({
      name: 'r',
      dataset: ds(),
      task: () => 'out',
      scorers: [rubric, quality],
    });
    const collisions = warned.filter((w) => w.includes('metric name'));
    assert.equal(collisions.length, 1);
    assert.match(collisions[0]!, /'quality'/);
    assert.match(collisions[0]!, /'rubric'/); // both contributing scorers are named
    assert.match(collisions[0]!, /non-directionally/);
    // The run succeeded and reported: warning, not failure.
    assert.equal(result.caseCount, 1);
    assert.equal(complete(calls).status, 'completed');
    assert.ok(complete(calls).scorers);
  });

  // --- 3 + 4. regression guards ---

  it('does not warn or throw when every metric name is unique', async () => {
    const calls = capture();
    const warned = captureWarnings();
    const accuracy = scorer(() => 1.0, { name: 'accuracy' });
    const latency = scorer(() => ({ name: 'latency', value: 0.2 }), { name: 'latency' });
    const result = await evaluate({
      name: 'r',
      dataset: ds(),
      task: () => 'out',
      scorers: [accuracy, latency],
    });
    assert.equal(result.caseCount, 1);
    assert.equal(complete(calls).status, 'completed');
    assert.deepEqual(
      warned.filter((w) => w.includes('metric name')),
      [],
    );
  });

  it('does not warn for one scorer whose metric map is internally unique', async () => {
    const calls = capture();
    const warned = captureWarnings();
    const rubric = scorer(() => ({ quality: 0.8, fluency: 0.9 }), { name: 'rubric' });
    const result = await evaluate({
      name: 'r',
      dataset: ds(),
      task: () => 'out',
      scorers: [rubric],
    });
    assert.equal(result.caseCount, 1);
    assert.equal(complete(calls).status, 'completed');
    assert.deepEqual(
      warned.filter((w) => w.includes('metric name')),
      [],
    );
    const by: Record<string, any> = {};
    for (const s of complete(calls).scorers) by[s.name] = s;
    assert.deepEqual(by.rubric.emitted_metrics.map((m: any) => m.name).sort(), [
      'fluency',
      'quality',
    ]);
  });
});
