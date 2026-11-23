// Usage capture with auto-wired integrations (no instrumentModules). A require hook patches only
// when its module is required after the hook is installed, so usage counts as captured only once
// one has fired: wired but never patched (the ES module case) is "not captured", never zero.
// Kept in its own file because require hooks are process-wide: the order of requires matters.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';

import { evaluate } from '../src/eval';
import { TraceRoot, _resetForTesting } from '../src/traceroot';

async function llmCall(prompt: number): Promise<void> {
  const s = trace.getTracer('app').startSpan('llm', {
    attributes: { 'openinference.span.kind': 'LLM', 'llm.token_count.prompt': prompt },
  });
  await new Promise((r) => setTimeout(r, 1));
  s.end();
}

function autoWireLocalCapture(): void {
  process.env['TRACEROOT_ENABLED'] = 'false';
  TraceRoot._armUsageCapture();
  TraceRoot.initialize();
}

beforeEach(() => {
  _resetForTesting();
  delete process.env['TRACEROOT_API_KEY'];
});
afterEach(() => {
  delete process.env['TRACEROOT_ENABLED'];
  _resetForTesting();
});

// These run in order: nothing in this file requires 'openai' before the second test.
describe('auto-wired integrations', () => {
  it('is null when an auto-wired integration never patched a module', async () => {
    autoWireLocalCapture();
    assert.equal(TraceRoot._usageCapturable(true), true, 'wired');
    const result = await evaluate({
      name: 'never-patched',
      local: true,
      dataset: [{ id: 'x', input: 1 }],
      task: async () => {
        await llmCall(5);
        return 1;
      },
      scorers: [() => 1],
    });
    assert.equal(result.itemResults[0].usage, null, 'wired but never patched: not captured');
  });

  it('counts once an auto-wired hook patches, even lazily during the case', async () => {
    autoWireLocalCapture();
    assert.equal(TraceRoot._usageCaptured(true), false, 'not patched yet');
    const result = await evaluate({
      name: 'lazily-patched',
      local: true,
      dataset: [{ id: 'x', input: 1 }],
      task: async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('openai'); // the first require after the hook: it patches the module
        await llmCall(5);
        return 1;
      },
      scorers: [() => 1],
    });
    assert.equal(TraceRoot._usageCaptured(true), true);
    assert.equal(result.itemResults[0].usage?.task.llm_calls, 1);
    assert.equal(result.itemResults[0].usage?.task.input_tokens, 5);
  });
});
