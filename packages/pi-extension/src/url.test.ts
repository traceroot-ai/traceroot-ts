import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from './config.ts';
import { buildTraceUrl } from './url.ts';

test('builds a deep link when projectId and traceId are present', () => {
  const config = resolve({ projectId: 'proj-uuid', uiUrl: 'http://localhost:3000' });
  assert.equal(
    buildTraceUrl(config, 'abc123'),
    'http://localhost:3000/projects/proj-uuid/traces?traceId=abc123',
  );
});

test('trims trailing slashes from the UI base', () => {
  const config = resolve({ projectId: 'p', uiUrl: 'https://app.traceroot.ai/' });
  assert.equal(buildTraceUrl(config, 't'), 'https://app.traceroot.ai/projects/p/traces?traceId=t');
});

test('returns null without a projectId (no fabricated URL)', () => {
  const config = resolve({ uiUrl: 'http://localhost:3000' });
  assert.equal(buildTraceUrl(config, 'abc123'), null);
});

test('returns null without a traceId', () => {
  const config = resolve({ projectId: 'p' });
  assert.equal(buildTraceUrl(config, null), null);
});
