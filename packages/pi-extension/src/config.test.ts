import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  BOOLEAN_ENV_KEYS,
  collectEnvIssues,
  envRaw,
  resolve,
  sanitizeFileConfig,
  validateConfig,
} from './config.ts';
import type { ConfigIssue, RawConfig } from './config.ts';

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

test('collectEnvIssues warns on a set-but-unrecognized boolean and on malformed metadata', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    process.env.TRACEROOT_ENABLED = 'ture'; // typo — would otherwise be silently "off"
    process.env.TRACEROOT_ADDITIONAL_METADATA = '[1,2]'; // valid JSON but not an object
    const issues = collectEnvIssues();
    assert.ok(
      issues.some((i) => i.path === 'TRACEROOT_ENABLED' && i.severity === 'warning'),
      'unrecognized boolean is flagged',
    );
    assert.ok(
      issues.some((i) => i.path === 'TRACEROOT_ADDITIONAL_METADATA' && i.severity === 'warning'),
      'non-object metadata is flagged',
    );
  } finally {
    process.env = saved;
  }
});

test('BOOLEAN_ENV_KEYS covers every boolean env var parsed in envRaw (drift guard)', () => {
  // Extract the env-var literals passed to boolEnv(...) / firstBoolEnv(...) in the source.
  // If a new boolean var is parsed but not listed, a typo'd value would silently regress
  // to "unset" with no collectEnvIssues warning — the exact bug that list prevents.
  const src = readFileSync(new URL('./config.ts', import.meta.url), 'utf8');
  const parsed = new Set<string>();
  for (const call of src.matchAll(/(?:first)?[Bb]oolEnv\(([^)]*)\)/g)) {
    const args = call[1] ?? '';
    for (const lit of args.matchAll(/'([A-Z0-9_]+)'/g)) {
      const name = lit[1];
      if (name) parsed.add(name);
    }
  }
  assert.ok(parsed.size >= 7, 'sanity: found the boolEnv call sites in source');
  const missing = [...parsed].filter((k) => !BOOLEAN_ENV_KEYS.includes(k));
  assert.deepEqual(
    missing,
    [],
    `BOOLEAN_ENV_KEYS is missing parsed boolean env keys: ${missing.join(', ')}`,
  );
});

test('collectEnvIssues is silent for recognized values, unset vars, and valid metadata', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TRACEROOT_')) delete process.env[k];
    }
    process.env.TRACEROOT_ENABLED = 'yes';
    process.env.TRACEROOT_CAPTURE_TOOL_IO = 'off';
    process.env.TRACEROOT_ADDITIONAL_METADATA = '{"a":1}';
    assert.deepEqual(collectEnvIssues(), []);
  } finally {
    process.env = saved;
  }
});

test('sanitizeFileConfig drops type-mismatched boolean fields and warns (global file)', () => {
  const raw = { enabled: 'false', token: 'ok', captureToolIo: 1 } as unknown as RawConfig;
  const { sanitized, issues } = sanitizeFileConfig(raw, '/cfg.json');
  const record = sanitized as Record<string, unknown>;
  assert.equal('enabled' in record, false, 'string "false" is dropped from a boolean field');
  assert.equal('captureToolIo' in record, false, 'a number is dropped from a boolean field');
  assert.equal(record.token, 'ok', 'a valid string field is kept');
  assert.equal(
    'enabled' in (raw as Record<string, unknown>),
    true,
    'the input is not mutated (pure)',
  );
  assert.ok(
    issues.some((i: ConfigIssue) => i.path.includes('enabled') && i.severity === 'warning'),
  );
  assert.ok(issues.some((i: ConfigIssue) => i.path.includes('captureToolIo')));
});

test('sanitizeFileConfig drops non-object additionalMetadata and warns', () => {
  const raw = { additionalMetadata: [1, 2] } as unknown as RawConfig;
  const { sanitized, issues } = sanitizeFileConfig(raw, '/cfg.json');
  assert.equal('additionalMetadata' in (sanitized as Record<string, unknown>), false);
  assert.ok(issues.some((i: ConfigIssue) => i.path.includes('additionalMetadata')));
});

test('sanitizeFileConfig keeps well-typed values and emits no issues', () => {
  const raw = {
    enabled: true,
    debug: false,
    token: 'k',
    additionalMetadata: { a: 1 },
  } as unknown as RawConfig;
  const { sanitized, issues } = sanitizeFileConfig(raw, '/cfg.json');
  assert.deepEqual(issues, []);
  assert.equal((sanitized as Record<string, unknown>).enabled, true);
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
