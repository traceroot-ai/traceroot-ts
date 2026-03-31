# TraceRoot TypeScript SDK

TypeScript SDK for [TraceRoot](https://traceroot.ai) — AI observability for LLM applications.

## Installation

```bash
npm install @traceroot/sdk
```

## Quickstart

```typescript
import OpenAI from 'openai';
import { TraceRoot, observe } from '@traceroot/sdk';

TraceRoot.initialize({
  apiKey: process.env.TRACEROOT_API_KEY,
  instrumentModules: { openAI: OpenAI },
});

const openai = new OpenAI();

async function main() {
  try {
    await observe({ name: 'my_session' }, async () => {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello!' }],
      });
      console.log(response.choices[0].message.content);
    });
  } finally {
    await TraceRoot.shutdown();
  }
}

main();
```

## API

### `TraceRoot.initialize(options?)`

Call once at startup before making any LLM calls.

| Option | Type | Description |
|---|---|---|
| `apiKey` | `string` | TraceRoot API key. Defaults to `TRACEROOT_API_KEY` env var. |
| `baseUrl` | `string` | Override API endpoint. Defaults to `TRACEROOT_HOST_URL` env var or `https://app.traceroot.ai`. |
| `instrumentModules` | `object` | Libraries to auto-instrument (see below). |
| `disableBatch` | `boolean` | Use `SimpleSpanProcessor` instead of batched. Useful for short-lived scripts. |
| `logLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | OTel diagnostic log level. Default: `'error'`. |

### `instrumentModules`

Pass the imported module object to enable auto-instrumentation:

```typescript
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import * as lcCallbackManager from '@langchain/core/callbacks/manager';

TraceRoot.initialize({
  instrumentModules: {
    openAI: OpenAI,            // OpenAI SDK
    anthropic: Anthropic,      // Anthropic SDK
    langchain: lcCallbackManager, // LangChain / LangGraph (do NOT also pass openAI)
  },
});
```

> **Note:** When using LangChain/LangGraph, do not also pass `openAI` — LangChain already captures LLM spans. Passing both creates duplicate spans.

### `observe(options, fn)`

Wraps an async function in a named span. Nested calls automatically become child spans.

```typescript
const result = await observe({ name: 'agent_turn', type: 'agent' }, async () => {
  // everything inside is traced as children
  return await myAgent.run(input);
});
```

| Option | Type | Description |
|---|---|---|
| `name` | `string` | Span name. Defaults to function name. |
| `type` | `'span' \| 'agent' \| 'tool' \| 'llm'` | OpenInference span kind. Default: `'span'`. |
| `input` | `unknown` | Input value to record on the span. |

### `TraceRoot.shutdown()`

Flushes all pending spans and closes the exporter. Call in a `finally` block for scripts.

```typescript
try {
  await observe({ name: 'session' }, async () => { /* ... */ });
} finally {
  await TraceRoot.shutdown();
}
```

### `updateCurrentSpan(attrs)` / `updateCurrentTrace(attrs)`

Set custom attributes on the active span or trace from anywhere in the call stack.

```typescript
import { updateCurrentSpan } from '@traceroot/sdk';

updateCurrentSpan({ userId: 'u_123', environment: 'production' });
```

## Development

```bash
pnpm install
make build
make test
```

## License

Apache-2.0
