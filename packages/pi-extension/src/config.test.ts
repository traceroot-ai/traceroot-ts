import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envRaw, resolve, validateConfig } from './config.ts';

test('resolve applies cloud defaults', () => {
  const c = resolve({});
  assert.equal(c.enabled, false);
  assert.equal(c.apiUrl, 'https://app.traceroot.ai');
  assert.equal(c.uiUrl, 'https://app.traceroot.ai');
  assert.equal(c.otlpEndpoint, 'https://app.traceroot.ai/api/v1/public/traces');
  assert.equal(c.project, 'pi');
  assert.equal(c.serviceName, 'pi-agent');
  assert.equal(c.showUiIndicator, true);
});

test('local mode flips the endpoint and UI defaults', () => {
  const c = resolve({ localMode: true });
  assert.equal(c.apiUrl, 'http://localhost:8000');
  assert.equal(c.uiUrl, 'http://localhost:3000');
  assert.equal(c.otlpEndpoint, 'http://localhost:8000/api/v1/public/traces');
});

test('explicit otlpEndpoint overrides the derived one', () => {
  const c = resolve({ localMode: true, otlpEndpoint: 'http://host:9/ingest' });
  assert.equal(c.otlpEndpoint, 'http://host:9/ingest');
});

test('envRaw reads only the variables that are set', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_') || k === 'PI_PARENT_SPAN_ID' || k === 'PI_ROOT_SPAN_ID') {
        delete process.env[k];
      }
    }
    process.env.TRACEROOT_PI_ENABLED = 'true';
    process.env.TRACEROOT_TOKEN = 'tok';
    process.env.TRACEROOT_LOCAL_MODE = 'true';
    const raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, 'tok');
    assert.equal(raw.localMode, true);
    assert.equal('project' in raw, false); // unset stays absent so lower layers win
  } finally {
    process.env = saved;
  }
});

test('accepts SDK-standard env names, with legacy names as aliases', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    // SDK-standard names
    process.env.TRACEROOT_ENABLED = 'true';
    process.env.TRACEROOT_API_KEY = 'sdk-key';
    let raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, 'sdk-key');

    // Legacy pi-scoped names still work
    delete process.env.TRACEROOT_ENABLED;
    delete process.env.TRACEROOT_API_KEY;
    process.env.TRACEROOT_PI_ENABLED = 'true';
    process.env.TRACEROOT_TOKEN = 'legacy-key';
    raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, 'legacy-key');

    // SDK name wins when both are present
    process.env.TRACEROOT_API_KEY = 'sdk-wins';
    assert.equal(envRaw().token, 'sdk-wins');
  } finally {
    process.env = saved;
  }
});

test('enabled accepts common truthy/falsey spellings; unrecognized values use the default', () => {
  const saved = { ...process.env };
  try {
    process.env.TRACEROOT_PI_ENABLED = '1';
    assert.equal(resolve(envRaw()).enabled, true, "'1' enables");
    process.env.TRACEROOT_PI_ENABLED = 'YES';
    assert.equal(resolve(envRaw()).enabled, true, "'YES' enables (case-insensitive)");
    process.env.TRACEROOT_PI_ENABLED = 'off';
    assert.equal(resolve(envRaw()).enabled, false, "'off' disables");
    process.env.TRACEROOT_PI_ENABLED = 'banana';
    assert.equal(
      resolve(envRaw()).enabled,
      false,
      'an unrecognized value falls back to the default (false)',
    );
  } finally {
    process.env = saved;
  }
});

test('resolve keeps only primitive additionalMetadata values', () => {
  const c = resolve({ additionalMetadata: { a: 'x', n: 1, b: true, obj: { k: 1 }, arr: [1] } });
  assert.deepEqual(c.additionalMetadata, { a: 'x', n: 1, b: true });
});

test('validateConfig is clean for a well-formed enabled cloud config', () => {
  assert.equal(validateConfig(resolve({ enabled: true, token: 't' })).length, 0);
});

test('validateConfig warns when enabled without a token', () => {
  const issues = validateConfig(resolve({ enabled: true }));
  assert.ok(issues.some((i) => i.path === 'token' && i.severity === 'warning'));
});

test('validateConfig warns on a non-https cloud endpoint', () => {
  const issues = validateConfig(
    resolve({ enabled: true, token: 't', apiUrl: 'http://example.com' }),
  );
  assert.ok(issues.some((i) => i.path === 'otlpEndpoint' && i.severity === 'warning'));
});

test('validateConfig errors on a malformed url', () => {
  for (const apiUrl of ['not-a-url', 'http://', 'https:// space', 'ftp://host']) {
    const issues = validateConfig(resolve({ apiUrl }));
    assert.ok(
      issues.some((i) => i.severity === 'error'),
      `expected an error for apiUrl=${JSON.stringify(apiUrl)}`,
    );
  }
});
