// llmJudge score parsing is an unambiguous exact-value parser, not "first number
// wins". A malformed/ambiguous response is an isolated scorer error, never a wrong silent
// score. Parity with traceroot-py/tests/eval/test_judge_parsing.py.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { llmJudge } from '../src/eval';
// The judge authoring types must be reachable from the package root so a consumer can annotate an
// llmJudge config / builder — tsc fails this import if they are not exported (see eval/index.ts).
import type { LlmJudgeOptions, JudgeBuilder, JudgeMessage } from '../src/eval';

const _judgeTypesExported: [LlmJudgeOptions, JudgeBuilder, JudgeMessage] | null = null;
void _judgeTypesExported;

function judgeReturning(resp: string) {
  return llmJudge({
    name: 'j',
    model: 'm',
    messages: [{ role: 'user', content: 'ANSWER:\n{{output}}' }],
    complete: async () => resp,
  });
}
const ctx = { input: null, output: 'x', expected: null, metadata: null } as any;
const value = async (resp: string): Promise<number> =>
  ((await judgeReturning(resp)(ctx)) as any).value;

describe('llmJudge score parsing', () => {
  it('accepts an exact numeric response', async () => {
    assert.equal(await value('0.8'), 0.8);
    assert.equal(await value('1.0'), 1.0);
    assert.equal(await value('  0  '), 0);
    assert.equal(await value('-2'), -2);
  });

  it('tolerates a trailing period', async () => {
    assert.equal(await value('1.0.'), 1.0);
  });

  it('accepts a single unambiguous number in prose', async () => {
    assert.equal(await value('The score is 0.8'), 0.8);
  });

  it('does not turn "Step 3: the score is 0.8" into 3', async () => {
    await assert.rejects(
      () => judgeReturning('Step 3: the score is 0.8')(ctx) as any,
      /single numeric score/,
    );
  });

  it('rejects an ambiguous multi-number response', async () => {
    await assert.rejects(() => judgeReturning('1 out of 10')(ctx) as any);
  });

  it('rejects a response with no number', async () => {
    await assert.rejects(() => judgeReturning('no idea')(ctx) as any);
  });
});
