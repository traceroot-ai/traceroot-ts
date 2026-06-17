# traceroot-pi-extension

Automatic [OpenTelemetry](https://opentelemetry.io/) tracing for [pi](https://pi.dev)
coding-agent sessions, exported to [Traceroot](https://traceroot.ai).

The extension subscribes to pi's lifecycle events and emits a span tree for every
session: sessions, turns, LLM calls (with token usage and cost), and tool
executions. Spans are exported over OTLP/protobuf to Traceroot's ingest endpoint.

## Span tree

```
pi.session
└── pi.turn                       (one per prompt; prompt text as an attribute)
    ├── {provider}/{model}        (LLM span: tokens, cost, finish reason)
    │   ├── pi.tool.read          (args, result preview, duration)
    │   └── pi.tool.bash          (parallel-safe; keyed by tool call id)
    └── {provider}/{model}        (second LLM turn after tool results)
        └── pi.tool.write
```

## Install

```bash
pi install npm:traceroot-pi-extension
```

The extension is **opt-in**: it registers no listeners and emits no spans unless
`TRACEROOT_PI_ENABLED=true`.

## Quick start

### Traceroot Cloud

```bash
TRACEROOT_PI_ENABLED=true \
TRACEROOT_TOKEN=<your-token> \
pi
```

### Local Traceroot

```bash
TRACEROOT_PI_ENABLED=true \
TRACEROOT_LOCAL_MODE=true \
TRACEROOT_TOKEN=<local-token> \
TRACEROOT_PROJECT_ID=<project-uuid> \
pi
```

`TRACEROOT_LOCAL_MODE=true` points the exporter at `http://localhost:8000` and the
trace-link UI at `http://localhost:3000`. `TRACEROOT_PROJECT_ID` (the project UUID)
is only needed for the clickable trace URL in the TUI.

## Configuration

Precedence, lowest to highest: built-in defaults, `~/.pi/agent/traceroot.json`,
`traceroot.config.{ts,js,mjs}` in the working directory, then environment
variables. A project-local `.pi/traceroot.json` is also merged, but only when the
project is trusted and only for presentation fields (`project`, `projectId`,
`showUiIndicator`, `debug`) — never the token or endpoint.

| Environment variable | Default | Description |
|---|---|---|
| `TRACEROOT_PI_ENABLED` | `false` | Master opt-in. No spans unless `true`. |
| `TRACEROOT_TOKEN` | — | Traceroot access token (Bearer). Required. |
| `TRACEROOT_LOCAL_MODE` | `false` | Use localhost defaults for endpoint and UI. |
| `TRACEROOT_API_URL` | `https://api.traceroot.ai` | Ingest API base. |
| `TRACEROOT_OTLP_ENDPOINT` | `<api>/api/v1/public/traces` | Explicit OTLP endpoint override. |
| `TRACEROOT_UI_URL` | `https://app.traceroot.ai` | Web UI base for trace links. |
| `TRACEROOT_PROJECT` | `pi` | Project label. |
| `TRACEROOT_PROJECT_ID` | — | Project UUID, used to build trace URLs. |
| `TRACEROOT_SERVICE_NAME` | `pi-agent` | OTel `service.name`. |
| `TRACEROOT_ENVIRONMENT` | `development` | Deployment environment. |
| `TRACEROOT_GITHUB_OWNER` / `_REPO_NAME` / `_COMMIT_HASH` | — | Optional source attribution. |
| `TRACEROOT_CAPTURE_FULL_PAYLOAD` | `false` | Capture full LLM request payloads. May contain PII. |
| `TRACEROOT_SHOW_UI` | `true` | Show the TUI status indicator and trace-URL widget. |
| `TRACEROOT_PI_DEBUG` | `false` | Log span lifecycle to stderr. |

## The `/traceroot` command

In the TUI, `/traceroot <subcommand>`:

- `status` — print config and the active trace URL
- `open` — open the active trace in your browser
- `flush` — force-flush pending spans
- `disable` / `enable` — turn tracing off/on for the current session

## Captured attributes

LLM spans use the OpenTelemetry GenAI semantic conventions:

- `gen_ai.system`, `gen_ai.request.model`, `gen_ai.request.thinking_level`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
  `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.cache_write_input_tokens`
- `traceroot.pi.total_tokens`, `traceroot.pi.cost_total`, `traceroot.pi.finish_reason`
- `traceroot.pi.request_message_count`, `http.status_code`,
  `traceroot.pi.context_tokens`, `traceroot.pi.context_percentage`

Tool spans: `gen_ai.tool.name`, `gen_ai.tool.call.id`, `traceroot.pi.tool_args`
(truncated), `traceroot.pi.tool_result` (truncated), `traceroot.pi.tool_is_error`,
`traceroot.pi.tool_duration_ms`.

## Reliability

Tracing never crashes pi. Setup failures are caught and the extension returns
quietly; export failures are retried by the batch processor and otherwise swallowed.
On exit, open spans are closed in reverse nesting order and pending spans are flushed
with a bounded timeout so the process never hangs.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

Apache-2.0
