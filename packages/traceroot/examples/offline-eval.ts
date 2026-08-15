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
import { Dataset, evaluate, scorer, llmJudge, FakeTransport } from '@traceroot-ai/traceroot';
import type { ScorerContext } from '@traceroot-ai/traceroot';

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

// 3. Scorers. `scorer()` declares the metric's policy (how the value is compared + the pass
//    threshold). A scorer receives a ScorerContext and returns a value, a bool, a Score, or an
//    array of Scores. The emitted Score name may differ from the function name.
const accuracy = scorer(
  function accuracy(ctx: ScorerContext) {
    return (ctx.output as any).route === (ctx.expected as any).route ? 1.0 : 0.0;
  },
  { valueType: 'numeric', direction: 'higher_is_better', threshold: 1.0 },
);

const isConfident = scorer(
  function is_confident(ctx: ScorerContext) {
    return { name: 'confident', value: (ctx.output as any).route !== 'general' };
  },
  { valueType: 'boolean' },
);

// An LLM judge. `model` + `messages` are its reported definition; `{{output}}` interpolates the
// case. `complete` stubs the model so the example is deterministic and offline — drop it to call
// the real model named by `model`.
const tone = llmJudge({
  name: 'tone',
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'Rate politeness 0..1:\n{{output}}' }],
  complete: () => '0.9',
});

// 4. Run it. `mainScore` names the headline metric when several numeric metrics exist; with a
//    single scorer it is inferred from the one metric emitted, so it can be omitted. Swap the
//    FakeTransport for a pulled dataset + TRACEROOT_API_KEY to report the identical run.
const run = await evaluate({
  name: 'support-routing-v1',
  dataset,
  task: routeTicket,
  scorers: [accuracy, isConfident, tone],
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
