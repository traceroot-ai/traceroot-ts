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

test('encodes special characters in projectId and traceId (no raw shell metacharacters)', () => {
  const config = resolve({ projectId: 'a/b&c', uiUrl: 'http://localhost:3000' });
  const url = buildTraceUrl(config, 'x y&z');
  assert.ok(url);
  assert.ok(!/[&<>"|^\s]/.test(url), 'the built URL contains no raw shell metacharacters');
  assert.match(url, /\/projects\/a%2Fb%26c\/traces\?traceId=x%20y%26z$/);
});
