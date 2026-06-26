import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, type TracerootPiConfig } from './config.ts';
import { applyProjectLocal } from './project-config.ts';

test('applies allowed project-local fields', () => {
  const config = resolve({});
  const applied = applyProjectLocal(
    config,
    { project: 'my-test-project', projectId: 'uuid-1', showUiIndicator: false },
    new Set<keyof TracerootPiConfig>(),
  );
  assert.deepEqual(applied.sort(), ['project', 'projectId', 'showUiIndicator']);
  assert.equal(config.project, 'my-test-project');
  assert.equal(config.projectId, 'uuid-1');
  assert.equal(config.showUiIndicator, false);
});

test('env-provided fields are not overridden by project-local', () => {
  const config = resolve({ project: 'from-env' });
  const applied = applyProjectLocal(
    config,
    { project: 'from-file' },
    new Set<keyof TracerootPiConfig>(['project']),
  );
  assert.deepEqual(applied, []);
  assert.equal(config.project, 'from-env');
});

test('never applies the token from a project-local file', () => {
  const config = resolve({});
  applyProjectLocal(
    config,
    { token: 'leaked-token', project: 'ok' } as Record<string, unknown>,
    new Set<keyof TracerootPiConfig>(),
  );
  assert.equal(config.token, '');
  assert.equal(config.project, 'ok');
});

test('ignores project-local values whose runtime type does not match the field', () => {
  const config = resolve({});
  const applied = applyProjectLocal(
    config,
    { projectId: 42, debug: 'yes', showUiIndicator: 'true' } as Record<string, unknown>,
    new Set<keyof TracerootPiConfig>(),
  );
  assert.deepEqual(applied, [], 'type-mismatched values are not applied');
  assert.equal(config.projectId, undefined, 'a numeric projectId is rejected');
  assert.equal(config.debug, false, 'a string debug does not turn debug on');
  assert.equal(config.showUiIndicator, true, 'a string showUiIndicator keeps the default');
});

test('applies a well-typed boolean debug from a trusted project-local file', () => {
  const config = resolve({});
  const applied = applyProjectLocal(config, { debug: true }, new Set<keyof TracerootPiConfig>());
  assert.deepEqual(applied, ['debug']);
  assert.equal(config.debug, true);
});
