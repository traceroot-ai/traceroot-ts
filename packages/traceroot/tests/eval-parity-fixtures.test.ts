// Cross-language parity: assert the TypeScript implementation matches the shared golden
// fixture that traceroot-py validates against too (an identical copy lives in each repo).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { llmJudge, scorerMetadata } from '../src/eval';

const FIX = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'parity.json'), 'utf8'));
const ctx = { input: null, output: 'x', expected: null, metadata: null } as any;

describe('cross-language parity fixtures', () => {
  for (const case_ of FIX.judge_parsing as { text: string; expected?: number; error?: boolean }[]) {
    it(`judge parsing: ${JSON.stringify(case_.text)}`, async () => {
      // parseJudgeOutput is internal; exercise it through the llmJudge public path.
      const judge = llmJudge({
        name: 'j',
        model: 'm',
        messages: [{ role: 'user', content: '{{output}}' }],
        complete: async () => case_.text,
      });
      if (case_.error) {
        await assert.rejects(() => judge(ctx) as any);
      } else {
        assert.equal(((await judge(ctx)) as any).value, case_.expected);
      }
    });
  }

  for (const case_ of FIX.required_inputs as { content: string; expected: string[] }[]) {
    it(`required inputs: ${case_.content.slice(0, 20)}`, () => {
      const judge = llmJudge({
        name: 'j',
        model: 'm',
        messages: [{ role: 'user', content: case_.content }],
        complete: async () => '1',
      });
      assert.deepEqual(scorerMetadata(judge).required_inputs, case_.expected);
    });
  }
});
