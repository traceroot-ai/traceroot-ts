// Unified `Scorer` namespace: Scorer.code + Scorer.llmJudge (static & dynamic), aliases, hashing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Scorer, scorer, llmJudge, scorerMetadata } from '../src/eval/scorers';
import type { ScorerContext } from '../src/eval';

const MODEL = 'claude-sonnet-5';
const ctx = (output: unknown, query = 'hi'): ScorerContext => ({
  input: { query },
  output,
  expected: null,
  metadata: null,
});

describe('unified Scorer namespace (TS)', () => {
  it('Scorer.code(opts, fn) attaches metadata', () => {
    const covers = Scorer.code(
      { name: 'covers', key: 'covers', threshold: 1, direction: 'higher_is_better' },
      ({ output }: ScorerContext) => (output === 'x' ? 1 : 0),
    );
    const md = scorerMetadata(covers);
    assert.equal(md.key, 'covers');
    assert.equal(md.threshold, 1);
    assert.equal(md.scorer_type, 'code');
  });

  it('Scorer.llmJudge static: rubric only, runs, config-hash version', async () => {
    const judge = Scorer.llmJudge({
      name: 'no_conclusion',
      model: MODEL,
      rubric: 'Return 1 if the answer has no conclusion, otherwise 0.',
      threshold: 1,
      complete: () => '1.0',
    });
    const md = scorerMetadata(judge);
    assert.equal(md.scorer_type, 'llm_judge');
    assert.ok((md.version ?? '').startsWith('cfg_'));
    const score = (await judge(ctx('a concise answer'))) as { value: number };
    assert.equal(score.value, 1.0);
  });

  it('config hash is deterministic', () => {
    const mk = () =>
      Scorer.llmJudge({ name: 'j', model: MODEL, rubric: 'Grade 0..1.', threshold: 1 });
    assert.equal(scorerMetadata(mk()).version, scorerMetadata(mk()).version);
  });

  it('Scorer.llmJudge dynamic: builder returns a variable map', async () => {
    let seen: any[] = [];
    const judge = Scorer.llmJudge(
      {
        name: 'nc',
        model: MODEL,
        rubric: 'Evaluate {{ANSWER}} against {{USER_REQUEST}}.',
        threshold: 1,
        complete: (_m, msgs) => {
          seen = msgs;
          return '1';
        },
      },
      ({ input, output }: ScorerContext) => ({
        ANSWER: output,
        USER_REQUEST: (input as any).query,
      }),
    );
    const score = (await judge(ctx('the answer text', 'the question'))) as { value: number };
    assert.equal(score.value, 1);
    const rendered = seen.map((m) => m.content).join(' ');
    assert.ok(rendered.includes('the answer text') && rendered.includes('the question'));
  });

  it('Scorer.llmJudge dynamic: builder returns messages', async () => {
    let seen: any[] = [];
    const judge = Scorer.llmJudge(
      {
        name: 'nc',
        model: MODEL,
        rubric: 'unused',
        threshold: 1,
        complete: (_m, msgs) => {
          seen = msgs;
          return '0';
        },
      },
      ({ output }: ScorerContext) => [{ role: 'user', content: `Judge: ${output}` }],
    );
    assert.equal(((await judge(ctx('XYZ'))) as { value: number }).value, 0);
    assert.deepEqual(seen, [{ role: 'user', content: 'Judge: XYZ' }]);
  });

  it('dynamic builder with an unsupported return is an actionable error', async () => {
    const judge = Scorer.llmJudge(
      { name: 'nc', model: MODEL, rubric: 'r', threshold: 1, complete: () => '1' },
      (() => 0.5) as any, // a number is NOT a valid builder return
    );
    await assert.rejects(() => judge(ctx('x')) as Promise<unknown>, /dynamic builder/);
  });

  it('old aliases still work (scorer / llmJudge)', async () => {
    const s = scorer(({ output }: ScorerContext) => output === 1, { key: 'k' });
    assert.equal(scorerMetadata(s).key, 'k');
    const j = llmJudge({
      name: 'j',
      model: MODEL,
      messages: [{ role: 'user', content: '{{output}}' }],
      threshold: 1,
      complete: () => '1',
    });
    assert.equal(scorerMetadata(j).scorer_type, 'llm_judge');
    assert.equal(((await j(ctx('hello'))) as { value: number }).value, 1);
  });
});
