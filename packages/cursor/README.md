# @traceroot-ai/cursor

OpenTelemetry instrumentation for the [Cursor Agent SDK](https://www.npmjs.com/package/@cursor/sdk).
Wraps an `Agent` so each `agent.send()` call produces a `cursor.run` span with
`cursor.tool.*` children, token usage attributes, and OpenInference fields for
input, output, model, session, and user.

## Install

```bash
npm install @traceroot-ai/cursor @cursor/sdk
```

## Usage

```ts
import { Agent } from "@cursor/sdk";
import { initialize, wrapAgent, flush, shutdown } from "@traceroot-ai/cursor";

initialize({
  apiKey: process.env.TRACEROOT_API_KEY!,
  baseUrl: "https://app.traceroot.ai",
});

const agent = wrapAgent(
  await Agent.create({
    apiKey: process.env.CURSOR_API_KEY!,
    model: { id: "composer-2" },
    local: { cwd: process.cwd() },
  }),
  { sessionId: "session-1", userId: "user-1" },
);

const run = await agent.send("Explain this project in one paragraph.");

for await (const event of run.stream()) {
  if (event.type !== "assistant") continue;
  for (const block of event.message.content) {
    if (block.type === "text") process.stdout.write(block.text);
  }
}

await flush();
await shutdown();
```

The stream-consumption code is unchanged from a normal Cursor SDK program. Only
the `initialize` and `wrapAgent` calls are added.

## What gets emitted per `agent.send()`

One `cursor.run` root span:

- `cursor.{agent_id, run_id, model_id, runtime, session_id, user_id, terminal_status}`
- `cursor.usage.{input,output,cache_read,cache_write}_tokens`
- OpenInference: `openinference.span.kind=AGENT`, `session.id`, `user.id`,
  `llm.model_name`, `llm.token_count.{prompt,completion,total}`,
  `input.value`, `output.value`

One `cursor.tool.<type>` child span per tool call:

- `openinference.span.kind=TOOL`
- `cursor.tool.{call_id, type, result_status, result_preview}`

If a run is cancelled, dangling tool spans are auto-closed with
`cursor.tool.terminated_by_cancel=true`.

## Options

```ts
interface WrappedAgentOptions {
  sessionId?: string;
  userId?: string;
  captureBodies?: boolean;        // include assistant text & tool args; default false
  runtime?: "local" | "cloud";    // default "local"
  tracer?: Tracer;                // override the private tracer set up by initialize()
}
```

`initialize` sets up a private `BasicTracerProvider` with an OTLP exporter
pointing at the TraceRoot backend. It does not touch the OpenTelemetry global
tracer, so `@cursor/sdk`'s internal infrastructure spans are not exported.

## Scope

- Local Cursor runtime (`AgentOptions.local`).
- Cloud runtime (`AgentOptions.cloud`) is not yet covered.
- The package is an event-to-span adapter. Span batching and OTLP transport
  come from `@opentelemetry/sdk-trace-base` and
  `@opentelemetry/exporter-trace-otlp-proto`.

## License

MIT
