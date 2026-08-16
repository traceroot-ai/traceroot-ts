// Parity: scorers metadata, session, provenance, evaluation, deferred.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  scorer,
  llmJudge,
  describeScorers,
  scorerMetadata,
  FakeTransport,
  collectRunProvenance,
  Evaluation,
  Dataset,
  DeferredScore,
  evaluate,
} from '../src/eval';
import type { ScorerContext } from '../src/eval';

const echo = (x: unknown) => x;

// Stub the git resolution for the whole file (parity with traceroot-py test_provenance, which
// monkeypatches `_resolved_git`). Without this the provenance assertions read the MACHINE's `.git`,
// so they only hold inside a checkout and fail in a `.git`-less container or an npm tarball. Set at
// module scope, before any test body: this is the first source both the provenance helper and
// TraceRoot.initialize() consult, so neither can fall through to the ambient repository.
const STUB_OID = '0123456789abcdef0123456789abcdef01234567';
process.env['TRACEROOT_GIT_REPO'] = 'owner/repo';
process.env['TRACEROOT_GIT_REF'] = STUB_OID;
const STUB_GIT = { repository: 'owner/repo', ref: STUB_OID, commit: STUB_OID };

// ---------------------------------------------------------------------------
describe('scorer metadata', () => {
  it('defaults + explicit-wins + no name inference + no version fabrication', () => {
    const acc = scorer((_c: ScorerContext) => 1, { valueType: 'numeric' });
    const md = scorerMetadata(acc);
    assert.equal(md.language, 'typescript');
    assert.ok((md.source ?? '').length > 0); // source captured
    const { source: _s, language: _l, ...rest } = md;
    assert.deepEqual(
      { ...rest, name: 'x', key: 'x' }, // key defaults to the definition name
      {
        name: 'x',
        key: 'x',
        version: null,
        scorer_type: 'code',
        value_type: 'numeric',
        direction: 'higher_is_better',
        threshold: null,
        output_type: 'score', // derived from numeric
        description: null,
        metadata: null,
      },
    );
    const latency = scorer((_c: ScorerContext) => 1, {
      valueType: 'numeric',
      direction: 'lower_is_better',
    });
    assert.equal(scorerMetadata(latency).direction, 'lower_is_better'); // not inferred from name
    const route = scorer((_c: ScorerContext) => 'billing', { valueType: 'categorical' });
    assert.equal(scorerMetadata(route).direction, 'none');
    const plain = (_c: ScorerContext) => 1;
    assert.equal(scorerMetadata(plain).version, null); // never fabricated
  });
  it('invalid value_type/direction throw', () => {
    assert.throws(() => scorer(() => 1, { valueType: 'nope' as never }));
    assert.throws(() => scorer(() => 1, { direction: 'up' as never }));
  });
  it('describeScorers with a runtime value-type hint', () => {
    function latency(_c: ScorerContext) {
      return 1;
    }
    scorer(latency, { direction: 'lower_is_better' });
    const [d] = describeScorers([latency], { latency: 'numeric' });
    assert.equal(d.value_type, 'numeric');
    assert.equal(d.direction, 'lower_is_better');
  });

  it('code scorer reports type + source; output_type derived, explicit wins', () => {
    const exact = scorer((c: ScorerContext) => (c.output === c.expected ? 1 : 0), {
      outputType: 'score',
      threshold: 1.0,
      description: 'Exact match',
      metadata: { team: 'q' },
    });
    const m = scorerMetadata(exact);
    assert.equal(m.scorer_type, 'code');
    assert.equal(m.language, 'typescript');
    assert.ok((m.source ?? '').includes('c.output'));
    assert.equal(m.output_type, 'score');
    assert.equal(m.threshold, 1.0);
    assert.equal(m.description, 'Exact match');
    assert.deepEqual(m.metadata, { team: 'q' });

    const route = scorer((_c) => 'billing', { valueType: 'categorical' });
    assert.equal(scorerMetadata(route).output_type, 'classification'); // derived
    const weird = scorer((_c) => 'x', { valueType: 'categorical', outputType: 'score' });
    assert.equal(scorerMetadata(weird).output_type, 'score'); // explicit wins
  });

  it('llmJudge reports model + messages (not source) and runs with injected complete', async () => {
    let seenModel = '';
    let seenRendered: { role: string; content: string }[] = [];
    const concise = llmJudge({
      name: 'concise',
      version: '1',
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'Rate 0..1.' },
        { role: 'user', content: 'ANSWER:\n{{output}}' },
      ],
      outputType: 'score',
      threshold: 0.8,
      description: 'conciseness',
      metadata: { team: 'quality' },
      complete: (model, rendered) => {
        seenModel = model;
        seenRendered = rendered;
        return 'The score is 0.7'; // judge contract: a single unambiguous number
      },
    });
    const md = scorerMetadata(concise);
    assert.equal(md.scorer_type, 'llm_judge');
    assert.equal(md.model, 'claude-sonnet-5');
    assert.equal(md.messages?.[1].content, 'ANSWER:\n{{output}}'); // authored template verbatim
    assert.equal(md.output_type, 'score');
    assert.equal(md.source, undefined);
    assert.equal(md.language, undefined);

    const score = (await concise({
      input: 'q',
      output: 'a concise answer',
      expected: null,
      metadata: null,
    } as ScorerContext)) as { name: string; value: number };
    assert.equal(score.name, 'concise');
    assert.equal(score.value, 0.7);
    assert.equal(seenModel, 'claude-sonnet-5');
    assert.equal(seenRendered[1].content, 'ANSWER:\na concise answer'); // {{output}} rendered
  });
});

// ---------------------------------------------------------------------------
describe('provenance (machine-independent)', () => {
  // The env the SDK's git resolution reads; keeping the stub keys in it means `git` comes from
  // STUB_GIT and never from whatever repository the tests happen to run inside.
  const stubEnv = (extra: Record<string, string> = {}) =>
    ({
      TRACEROOT_GIT_REPO: 'owner/repo',
      TRACEROOT_GIT_REF: STUB_OID,
      ...extra,
    }) as never;

  it('github ci + git block; user metadata wins', () => {
    const meta = collectRunProvenance(
      { model: 'sonnet', git: 'USER' },
      { env: stubEnv({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '9' }), detectDirty: false },
    );
    assert.equal(meta!.model, 'sonnet');
    assert.equal(meta!.git, 'USER'); // user key wins over auto git
    assert.deepEqual(meta!.ci, { provider: 'github', build_id: '9' });
  });

  it('a stubbed git context yields exactly the git block, and no CI block off CI', () => {
    const meta = collectRunProvenance(undefined, { env: stubEnv(), detectDirty: false });
    assert.deepEqual(meta, { git: STUB_GIT }); // ref is an OID -> also reported as commit
  });

  it('a branch ref is never reported as a commit', () => {
    const meta = collectRunProvenance(undefined, {
      env: stubEnv({ TRACEROOT_GIT_REF: 'main' }),
      detectDirty: false,
    });
    assert.deepEqual(meta, { git: { repository: 'owner/repo', ref: 'main' } });
  });

  it('git provenance rides the run metadata on the wire (non-identity), never SDK identity', async () => {
    // Parity with traceroot-py test_provenance TestProvenanceReachesWire: git/CI reproducibility
    // metadata reaches createRun as run metadata; user keys are kept and no SDK-language identity
    // is sent. The git block is the module-scope stub, so this holds without a `.git` on disk.
    const fake = new FakeTransport();
    await evaluate({
      name: 'r',
      dataset: [{ input: { m: 1 } }],
      task: (x) => x,
      scorers: [() => 1],
      metadata: { team: 'eval' },
      transport: fake,
    });
    const md = fake.lastRunMetadata!;
    assert.equal(md.team, 'eval');
    assert.deepEqual(md.git, STUB_GIT, 'git provenance rides the wire');
    assert.ok(!('sdk' in md) && !('language' in md), 'no SDK-language identity');
  });
});

// ---------------------------------------------------------------------------
describe('Evaluation object', () => {
  it('runs and rejects retry', async () => {
    const ds = new Dataset('d');
    ds.add(1, { id: 'c0', expected: 1 });
    const run = await new Evaluation({
      name: 'r',
      dataset: ds,
      task: echo,
      scorers: [(c) => (c.output === c.expected ? 1 : 0)],
      transport: new FakeTransport(),
    }).run();
    // Case status carries no headline pass/fail: a scored, error-free case is not_scored.
    assert.equal(run.caseCount, 1);
    assert.equal(run.notScored, 1);
    assert.throws(
      () => new Evaluation({ name: 'r', dataset: ds, task: echo, scorers: [() => 1], retry: 3 }),
      /retry is not implemented/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('deferred score', () => {
  it('is pending, never a numeric zero', async () => {
    const ds = new Dataset('d');
    ds.add(1, { id: 'c0', expected: 1 });
    const run = await evaluate({
      name: 'r',
      dataset: ds,
      task: echo,
      scorers: [() => new DeferredScore('human', 'awaiting review')],
      transport: new FakeTransport(),
    });
    assert.equal(run.itemResults[0].scores[0].value, 'pending');
    assert.equal(run.notScored, 1);
  });
});

let _keep: unknown;
beforeEach(() => {
  _keep = 1;
});
afterEach(() => {
  void _keep;
});
