# TraceRoot TypeScript SDK

[![Y Combinator][y-combinator-image]][y-combinator-url]
[![License][license-image]][license-url]
[![npm][npm-image]][npm-url]
[![X (Twitter)][twitter-image]][twitter-url]
[![Discord][discord-image]][discord-url]
[![Documentation][docs-image]][docs-url]

# Documentation

Please see the [TypeScript SDK Docs](https://traceroot.ai/docs/tracing/get-started) for details.

# Offline Evaluation

Run your AI app over a dataset, score each case with your own scorers, and report the results to
TraceRoot to compare candidates over time. A runnable end-to-end example lives in
[`examples/offline-eval.ts`](examples/offline-eval.ts) (it needs no backend — see below).

## Quickstart (5 minutes)

```ts
import { Dataset, evaluate, scorer } from '@traceroot-ai/traceroot';
import type { ScorerContext } from '@traceroot-ai/traceroot';

// 1. A dataset — cases with an input and an optional expected reference. `add(input, opts?)`:
//    the input is positional; `expected` / `id` / `metadata` go in the opts object.
const dataset = new Dataset('support-routing');
dataset.add({ message: 'I was charged twice' }, { expected: { route: 'billing' } });
dataset.add({ message: 'the app keeps crashing' }, { expected: { route: 'technical' } });

// 2. Your app (the "task"): one case input -> one candidate output.
function routeTicket(t: { message: string }) {
  const m = t.message.toLowerCase();
  return { route: m.includes('charge') ? 'billing' : m.includes('crash') ? 'technical' : 'general' };
}

// 3. A scorer. scorer() declares the metric's comparison policy; it receives a ScorerContext
//    (input / output / expected / metadata) and returns a value, bool, Score, or array of Scores.
const accuracy = scorer(
  function accuracy(ctx: ScorerContext) {
    return (ctx.output as any).route === (ctx.expected as any).route ? 1 : 0;
  },
  { valueType: 'numeric', direction: 'higher_is_better', threshold: 1.0 },
);

// 4. Run it. evaluate() pulls its cases from a synced dataset and reports to the platform.
const run = await evaluate({ name: 'routing-v1', dataset, task: routeTicket, scorers: [accuracy] });
console.log(run.summary());
```

## Datasets: create, publish, pull, version

```ts
import { Dataset, pullDataset } from '@traceroot-ai/traceroot';

const ds = new Dataset('support-routing');                 // create
ds.upsert({ input: { message: 'hi' }, id: 'c1', expected: { route: 'general' } });
await ds.push();                                            // publish to the platform (a version)

const pulled = await pullDataset('<dataset-id>');           // pull current version (needs creds)
const exact = await pullDataset('<dataset-id>', { versionId: '<version-id>' }); // pinned version
await ds.push(undefined, '<version-id>');                   // publish a NEW version off an existing one
```

Pulling a dataset stamps its `datasetId`/`datasetVersionId` onto the returned `Dataset`, so a run
against it is pinned to the exact cases it scored (reproducible).

## Scorers

A **deterministic** scorer is any function of the `ScorerContext`. `scorer()` declares its metric
policy; the emitted `Score` name may differ from the function name (a `grade` function may emit a
`quality` metric):

```ts
const grade = scorer(
  function grade(ctx: ScorerContext) {
    return { name: 'quality', value: latencySeconds(ctx.output) }; // emits the metric "quality"
  },
  { valueType: 'numeric', direction: 'lower_is_better', threshold: 0.2 },
);
```

An **LLM judge** — `model` + `messages` are its reported definition; `{{output}}` etc. interpolate
the case. Provide `complete` to stub the model (deterministic/offline), or omit it to call the real
model:

```ts
import { llmJudge } from '@traceroot-ai/traceroot';

const tone = llmJudge({
  name: 'tone',
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'Rate politeness 0..1:\n{{output}}' }],
});
```

## Main score, threshold, direction

- Each scorer declares its own **`threshold`** and **`direction`** (`higher_is_better` /
  `lower_is_better`); that policy decides whether the metric passes for a case.
- The **main score** is the headline metric that sets each case's pass/fail. With a **single**
  scorer it is inferred from the one metric emitted — you don't name it, even if the function name
  differs from the emitted metric name. With **multiple** numeric metrics, name it explicitly:
  `evaluate({ ..., mainScore: 'accuracy' })`; otherwise the run fails loudly rather than guess.

## Reporting, transports, and failure behavior

`evaluate` is cloud-first: it reports to TraceRoot using `TRACEROOT_API_KEY` and a synced dataset.
The **default transport** is built for you from those. Pass an **explicit transport** to control
reporting directly — both behave identically for scoring:

```ts
import { PlatformTransport } from '@traceroot-ai/traceroot';

const t = new PlatformTransport('<dataset-id>', { candidateVersion: 'v2' });
const run = await evaluate({ name: 'routing-v2', dataset: pulled, task: routeTicket, scorers: [accuracy], transport: t });
```

Honest statuses, never faked: a **task** error → `errored`; a **scorer** error is isolated to that
scorer (other scorers on the case still record); a case with no numeric/boolean score →
`not_scored` (never a silent 0).

## Candidate vs. baseline

Tag each run with `candidateVersion` (e.g. `'v1'`, `'gpt-4o'`); the SDK reports only the candidate
and never a baseline linkage — **comparison is done in the TraceRoot UI**, where you pick the
baseline run to diff against. Re-run the same dataset with a new `candidateVersion` to compare:

```ts
await evaluate({ name: 'routing', dataset: pulled, task: routeTicket, scorers: [accuracy], candidateVersion: 'v1' });
await evaluate({ name: 'routing', dataset: pulled, task: routeV2,     scorers: [accuracy], candidateVersion: 'v2' });
```

See the [platform evaluation docs](https://traceroot.ai/docs) for the UI: run tables, comparison,
and the scorer catalog.

<!-- Links -->

[discord-image]: https://img.shields.io/discord/1395844148568920114?logo=discord&labelColor=%235462eb&logoColor=%23f5f5f5&color=%235462eb
[discord-url]: https://discord.gg/tPyffEZvvJ
[docs-image]: https://img.shields.io/badge/docs-traceroot.ai-0dbf43
[docs-url]: https://traceroot.ai/docs/tracing/get-started
[license-image]: https://img.shields.io/badge/License-Apache%202.0-blue.svg
[license-url]: https://opensource.org/licenses/Apache-2.0
[npm-image]: https://img.shields.io/npm/v/%40traceroot-ai%2Ftraceroot?label=traceroot&labelColor=CB3837&color=555555
[npm-url]: https://www.npmjs.com/package/@traceroot-ai/traceroot
[twitter-image]: https://img.shields.io/twitter/follow/TracerootAI
[twitter-url]: https://x.com/TracerootAI
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
