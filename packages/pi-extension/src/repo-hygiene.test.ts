import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to the package root (this file lives in src/).
const fromRoot = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

test('the package is pnpm-only: no stray npm/yarn lockfiles are committed', () => {
  for (const lockfile of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']) {
    assert.equal(
      existsSync(fromRoot(lockfile)),
      false,
      `${lockfile} must not exist — this is a pnpm workspace and the root pnpm-lock.yaml is ` +
        `the single lockfile; a package-level one drifts from package.json`,
    );
  }
});

test('package.json is the single, self-consistent dependency manifest', () => {
  const pkg = JSON.parse(readFileSync(fromRoot('package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const dep = pkg.dependencies;
  // The OTLP exporter must stay on the 0.57.x experimental line that pairs with the
  // stable 1.30.x SDK packages (see provider.ts); a stale lockfile previously pinned an
  // older 0.53.x line, which is exactly the drift this guard prevents.
  assert.match(
    dep['@opentelemetry/exporter-trace-otlp-proto'] ?? '',
    /^\^0\.57\./,
    'exporter must be on the 0.57.x line',
  );
  for (const sdkPkg of [
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/sdk-trace-node',
  ]) {
    assert.match(dep[sdkPkg] ?? '', /^\^1\.30\./, `${sdkPkg} must be on the 1.30.x line`);
  }
});
