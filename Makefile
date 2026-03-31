.PHONY: install build test lint typecheck clean pack

install:
	pnpm install

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm lint

typecheck:
	pnpm typecheck

clean:
	pnpm clean

pack:
	pnpm --filter @traceroot-ai/traceroot build
	cd packages/sdk && npm pack
	@echo "Tarball ready in packages/sdk/"
