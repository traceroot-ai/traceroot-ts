# @traceroot-ai/mastra

[![Y Combinator][y-combinator-image]][y-combinator-url]
[![License][license-image]][license-url]
[![npm][npm-image]][npm-url]
[![X (Twitter)][twitter-image]][twitter-url]
[![Discord][discord-image]][discord-url]
[![Documentation][docs-image]][docs-url]

TraceRoot observability exporter for [Mastra](https://mastra.ai). Sends Mastra agent traces to TraceRoot with full span-type semantics (agent, tool, LLM).

## Installation

```bash
npm install @traceroot-ai/mastra @mastra/observability
```

## Usage

```ts
import { Mastra } from "@mastra/core";
import { Observability } from "@mastra/observability";
import { TraceRootExporter } from "@traceroot-ai/mastra";

export const mastra = new Mastra({
  agents: { myAgent },
  observability: new Observability({
    configs: {
      traceroot: {
        serviceName: "my-service",
        exporters: [
          new TraceRootExporter({
            apiKey: process.env.TRACEROOT_API_KEY,
          }),
        ],
      },
    },
  }),
});
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `apiKey` | `TRACEROOT_API_KEY` env | TraceRoot API key |
| `baseUrl` | `https://app.traceroot.ai` | TraceRoot backend URL (`TRACEROOT_HOST_URL` env) |
| `realtime` | `false` | Flush after every span (useful for short-lived scripts) |
| `disableBatch` | `false` | Use `SimpleSpanProcessor` instead of batch |
| `batchSize` | `512` | Max spans per export batch |
| `timeoutMillis` | `30000` | OTLP export timeout |

## Documentation

See the [TraceRoot Docs](https://traceroot.ai/docs/tracing/get-started) for details.

<!-- Links -->

[discord-image]: https://img.shields.io/discord/1395844148568920114?logo=discord&labelColor=%235462eb&logoColor=%23f5f5f5&color=%235462eb
[discord-url]: https://discord.gg/tPyffEZvvJ
[docs-image]: https://img.shields.io/badge/docs-traceroot.ai-0dbf43
[docs-url]: https://traceroot.ai/docs/tracing/get-started
[license-image]: https://img.shields.io/badge/License-Apache%202.0-blue.svg
[license-url]: https://opensource.org/licenses/Apache-2.0
[npm-image]: https://img.shields.io/npm/v/%40traceroot-ai%2Fmastra?label=%40traceroot-ai%2Fmastra&labelColor=CB3837&color=555555
[npm-url]: https://www.npmjs.com/package/@traceroot-ai/mastra
[twitter-image]: https://img.shields.io/twitter/follow/TracerootAI
[twitter-url]: https://x.com/TracerootAI
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
