import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const loader = pathToFileURL(path.join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href;
function run(
  mode: string,
  style: string,
  beta: boolean,
  format: string,
  version = 'modern',
  privacy = false,
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(ANTHROPIC_|TRACEROOT_|OTEL_|OPENINFERENCE_)/.test(key),
    ),
  );
  if (privacy) {
    env.OPENINFERENCE_HIDE_INPUTS = 'true';
    env.OPENINFERENCE_HIDE_OUTPUTS = 'true';
  }
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      loader,
      'tests/fixtures/anthropic-usage.cjs',
      mode,
      style,
      String(Number(beta)),
      format,
      version,
      String(Number(privacy)),
    ],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    JSON.parse(result.stdout).spans,
    mode === 'throwing' || style === 'error-stream' ? 0 : mode === 'nested' ? 4 : 2,
  );
}

describe('Anthropic usage has one recording owner per response', () => {
  for (const mode of ['both', 'native-only', 'oi-only', 'fallback']) {
    for (const style of ['create', 'create-stream', 'stream']) {
      for (const beta of [false, true]) {
        for (const format of ['cjs', 'esm']) {
          it(`${mode}: ${style}, beta=${beta}, ${format}`, () => run(mode, style, beta, format));
        }
      }
    }
  }
  for (const style of ['create', 'stream']) {
    it(`native tracer failure does not fail the request: ${style}`, () =>
      run('throwing', style, false, 'cjs'));
  }
  for (const mode of ['both', 'fallback']) {
    it(`stream helper request errors finish their span: ${mode}`, () =>
      run(mode, 'error-stream', false, 'cjs'));
  }
  for (const beta of [false, true]) {
    for (const style of ['create', 'stream']) {
      it(`CJS auto instrumentation: ${style}, beta=${beta}`, () =>
        run('both', style, beta, 'auto'));
    }
    it(`unwrapped native calls retain usage inside an OI call: beta=${beta}`, () =>
      run('nested', 'create', beta, 'cjs'));
    it(`countTokens keeps one traced operation: beta=${beta}`, () =>
      run('both', 'count', beta, 'cjs'));
  }
  for (const style of ['create', 'create-stream', 'stream']) {
    for (const beta of [false, true]) {
      for (const format of ['cjs', 'esm']) {
        it(`first native SDK: ${style}, beta=${beta}, ${format}`, () =>
          run('both', style, beta, format, 'native-first'));
        it(`native-free SDK: ${style}, beta=${beta}, ${format}`, () =>
          run('both', style, beta, format, 'legacy'));
      }
      it(`OI masking wins over native content capture: ${style}, beta=${beta}`, () =>
        run('both', style, beta, 'cjs', 'modern', true));
    }
  }
});
