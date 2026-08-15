// Phase 1 — progressive scorer API (TypeScript). A scorer is an ordinary function of the
// ScorerContext; the "plain" ergonomic is destructuring it (`({ input, output }) => ...`). Returns
// may be a scalar, a {name,value} object, a metric->value map, a Score, a Score[], or null — all
// normalizing to the same internal Score list. (JS can't reliably introspect parameter names under
// minification, so — unlike Python's positional (input, output, ...) — TS uses the typed context.)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { Dataset, evaluate, FakeTransport } from '../src/eval';
import type { ScorerContext } from '../src/eval';
import { _resetForTesting } from '../src/traceroot';
import { _resetSpansState } from '../src/spans';

let provider: NodeTracerProvider;
beforeEach(() => {
  provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()));
  provider.register();
});
afterEach(async () => {
  await provider.shutdown();
  _resetForTesting();
  _resetSpansState();
});

function ds() {
  const d = new Dataset('d');
  d.upsert({ input: { q: 'hi' }, id: 'c0', expected: 'hi' });
  return d;
}
async function scoresOf(scorers: any[], mainScore?: string) {
  const run = await evaluate({
    name: 'r',
    dataset: ds(),
    task: () => 'hi',
    scorers,
    mainScore,
    transport: new FakeTransport(),
  });
  return Object.fromEntries(run.itemResults[0].scores.map((s) => [s.name, s.value]));
}

describe('progressive scorer API (TS)', () => {
  it('plain destructured-context scorer works', async () => {
    const accuracy = ({ output, expected }: ScorerContext) => (output === expected ? 1 : 0);
    assert.deepEqual(await scoresOf([accuracy]), { accuracy: 1 });
  });

  it('backward-compatible single-ctx scorer still works', async () => {
    const byCtx = (ctx: ScorerContext) => (ctx.output === ctx.expected ? 1 : 0);
    assert.deepEqual(await scoresOf([byCtx]), { byCtx: 1 });
  });

  it('scalar boolean return carries a verdict', async () => {
    const isHi = ({ output }: ScorerContext) => output === 'hi';
    assert.deepEqual(await scoresOf([isHi]), { isHi: true });
  });

  it('metric-map return yields one Score per entry', async () => {
    const multi = ({ output }: ScorerContext) => ({
      len_ok: String(output).length > 0,
      starts_h: String(output).startsWith('h'),
    });
    assert.deepEqual(await scoresOf([multi], 'len_ok'), { len_ok: true, starts_h: true });
  });

  it('named object return stays a single Score', async () => {
    const one = (_ctx: ScorerContext) => ({ name: 'quality', value: 0.7 });
    assert.deepEqual(await scoresOf([one]), { quality: 0.7 });
  });
});
