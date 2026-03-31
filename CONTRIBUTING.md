# Contributing

## Setup

```bash
git clone https://github.com/traceroot-ai/traceroot-ts.git
cd traceroot-ts
pnpm install
```

## Development

```bash
make build      # build packages/sdk
make test       # run tests
make typecheck  # tsc --noEmit
make lint       # eslint
```

## Running examples

Set up your `.env` in the example directory (copy from `.env.example`), then:

```bash
cd examples/typescript/openai && pnpm demo
cd examples/typescript/langchain && pnpm demo
```

## Publishing a release

1. Bump version in `packages/sdk/package.json`
2. Commit and push
3. `git tag v0.x.y && git push --tags` — CI publishes to npm automatically

For a test release without publishing:

```bash
make pack
# → packages/sdk/@traceroot-sdk-0.x.y.tgz
```
