# TraceRoot TypeScript SDK

[![Y Combinator][y-combinator-image]][y-combinator-url]
[![License][license-image]][license-url]
[![npm][npm-image]][npm-url]
[![X (Twitter)][twitter-image]][twitter-url]
[![Discord][discord-image]][discord-url]
[![Documentation][docs-image]][docs-url]

# Documentation

Please see the [TypeScript SDK Docs](https://traceroot.ai/docs/tracing/get-started) for details.

## LiveKit Agents

LiveKit Agents can use the existing TraceRoot SDK primitives. Pass the LiveKit
Agents module into `initialize`, bind the room to TraceRoot context inside the
job, and flush when the job shuts down.

```ts
import { TraceRoot, usingAttributes } from '@traceroot-ai/traceroot';
import * as livekitAgents from '@livekit/agents';

TraceRoot.initialize({
  instrumentModules: { livekitAgents },
});

export async function entrypoint(ctx: livekitAgents.JobContext) {
  ctx.addShutdownCallback(() => TraceRoot.flush());

  await usingAttributes(
    {
      sessionId: ctx.room.name,
      tags: ['livekit', 'voice-agent'],
    },
    async () => {
      // Start the LiveKit AgentSession here.
    },
  );
}
```

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
