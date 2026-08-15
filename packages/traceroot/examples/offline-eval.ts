// Offline Evaluation — runnable end-to-end example (TypeScript).
//
// Evaluation is cloud-first: a real run pulls a dataset and reports results to the TraceRoot
// platform (see "Reporting to the platform" in the README):
//
//     import { pullDataset, evaluate } from '@traceroot-ai/traceroot';
//     const dataset = await pullDataset('<dataset-id>');            // needs TRACEROOT_API_KEY
//     const run = await evaluate({ name: '...', dataset, task, scorers: [...] });
//
// So it runs fully OFFLINE against the built package with no backend, this example passes an
// in-memory `FakeTransport` (the stand-in transport the SDK's own tests use) in place of the
// platform. Datasets, scorers, the ScorerContext, main-score resolution, and the four honest
// statuses are exactly what a reported run does.
//
//     npx tsx examples/offline-eval.ts
import { Dataset, evaluate, Scorer, FakeTransport } from '@traceroot-ai/traceroot';
import type { ScorerContext, Score } from '@traceroot-ai/traceroot';

// 1. The app under test (your "task"): one case input -> one candidate output.
function routeTicket(ticket: { message: string }): { route: string } {
  const m = ticket.message.toLowerCase();
  if (m.includes('refund') || m.includes('charge')) return { route: 'billing' };
  if (m.includes('crash') || m.includes('error')) return { route: 'technical' };
  return { route: 'general' };
}

// 2. A dataset: cases with an input and an optional expected reference.
// `add(input, opts?)` — the input is positional; `expected`/`id`/`metadata` go in the opts object.
const dataset = new Dataset('support-routing');
dataset.add({ message: 'I was charged twice' }, { expected: { route: 'billing' } });
dataset.add({ message: 'the app keeps crashing' }, { expected: { route: 'technical' } });
dataset.add({ message: 'hello there' }, { expected: { route: 'general' } });

// 3. Scorers: simplest first, then richer.
// (a) The simplest scorer is an ORDINARY FUNCTION of the ScorerContext — idiomatically destructured
//     `({ output }) => ...` — that returns a boolean or a number. No wrapper, no Score object.
const isGeneral = ({ output }: ScorerContext): boolean =>
  (output as { route: string }).route === 'general';

// (b) `Scorer.code(opts, fn)` is the same thing with declared POLICY: how the value is compared
//     (direction) and the pass threshold. A scorer may return a value, a bool, a Score, or an
//     array of Scores; the emitted Score name may differ from the function name.
const accuracy = Scorer.code(
  { valueType: 'numeric', direction: 'higher_is_better', threshold: 1.0 },
  (ctx: ScorerContext): Score => {
    const hit =
      (ctx.output as { route: string }).route === (ctx.expected as { route: string }).route;
    return {
      name: 'accuracy',
      value: hit ? 1.0 : 0.0,
      comment: (ctx.output as { route: string }).route,
    };
  },
);

// (c) `Scorer.llmJudge(opts)` is a STATIC judge: its declarative config (model + rubric/messages)
//     IS its versioned definition — no function body required. `{{output}}` interpolates the case.
//     `complete` stubs the model so the example is deterministic and offline — drop it to call the
//     real model named by `model`.
const tone = Scorer.llmJudge({
  name: 'tone',
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'Rate politeness 0..1:\n{{output}}' }],
  complete: () => '0.9',
});

// 4. Run it. `mainScore` names the headline metric when several numeric metrics exist; with a
//    single scorer it is inferred from the one metric emitted, so it can be omitted. Swap the
//    FakeTransport for a pulled dataset + TRACEROOT_API_KEY to report the identical run.
async function main() {
  const run = await evaluate({
    name: 'support-routing-v1',
    dataset,
    task: routeTicket,
    scorers: [isGeneral, accuracy, tone],
    mainScore: 'accuracy', // the metric that decides pass/fail per case
    candidateVersion: 'v1',
    transport: new FakeTransport(), // in-memory stand-in so the example needs no backend
  });

  // 5. Inspect results.
  console.log(run.summary());
  for (const item of run.itemResults) {
    const scores = item.scores.map((s) => `${s.name}=${JSON.stringify(s.value)}`).join(', ');
    console.log(`  ${item.caseId}: [${scores}]`);
  }
}

void main();
