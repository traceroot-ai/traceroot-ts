import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TraceRoot,
  _resetForTesting,
  resolveExportTarget,
  _getExportTargetForTesting,
} from '../src/traceroot';
import { TraceRootSpanProcessor } from '../src/processor';
import { isInternalMode, withForcedTraceId } from '../src/trace-id';
import { trace } from '@opentelemetry/api';

describe('TraceRoot.initialize()', () => {
  afterEach(() => {
    _resetForTesting();
  });

  it('isInitialized() returns false before initialize()', () => {
    assert.equal(TraceRoot.isInitialized(), false);
  });

  it('isInitialized() returns true after initialize()', () => {
    TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true });
    assert.equal(TraceRoot.isInitialized(), true);
  });

  it('warns but does not throw when apiKey is missing', () => {
    const messages: string[] = [];
    const restore = console.warn;
    console.warn = (...args: unknown[]) => {
      messages.push(args.join(' '));
    };
    try {
      assert.doesNotThrow(() => {
        TraceRoot.initialize({ disableBatch: true });
      });
      assert.ok(messages.some((m) => m.includes('TRACEROOT_API_KEY')));
    } finally {
      console.warn = restore;
    }
  });

  it('warns and skips on double initialize()', () => {
    const messages: string[] = [];
    const restore = console.warn;
    console.warn = (...args: unknown[]) => {
      messages.push(args.join(' '));
    };
    try {
      TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true });
      TraceRoot.initialize({ apiKey: 'test-key-2', disableBatch: true });
      assert.ok(messages.some((m) => m.toLowerCase().includes('already initialized')));
    } finally {
      console.warn = restore;
    }
    // Still reflects first init
    assert.equal(TraceRoot.isInitialized(), true);
  });

  it('flush() resolves without throwing when initialized', async () => {
    TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true });
    await assert.doesNotReject(() => TraceRoot.flush());
  });

  it('flush() resolves without throwing when not initialized', async () => {
    await assert.doesNotReject(() => TraceRoot.flush());
  });

  it('shutdown() resets isInitialized()', async () => {
    TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true });
    await TraceRoot.shutdown();
    assert.equal(TraceRoot.isInitialized(), false);
  });

  it('skips initialization when enabled: false is passed', () => {
    TraceRoot.initialize({ enabled: false });
    assert.equal(TraceRoot.isInitialized(), false);
  });

  it('skips initialization when TRACEROOT_ENABLED=false env var is set', () => {
    const prev = process.env['TRACEROOT_ENABLED'];
    process.env['TRACEROOT_ENABLED'] = 'false';
    try {
      TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true });
      assert.equal(TraceRoot.isInitialized(), false);
    } finally {
      if (prev === undefined) {
        delete process.env['TRACEROOT_ENABLED'];
      } else {
        process.env['TRACEROOT_ENABLED'] = prev;
      }
    }
  });

  it('completes initialization without error when environment is provided', () => {
    TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true, environment: 'prod' });
    assert.equal(TraceRoot.isInitialized(), true);
  });

  it('warns with "git context incomplete" when no git context is resolvable', () => {
    // Save and clear only the env vars the harvester actually reads.
    const saved = {
      GITHUB_REPOSITORY: process.env['GITHUB_REPOSITORY'],
      GITHUB_SHA: process.env['GITHUB_SHA'],
      TRACEROOT_GIT_REPO: process.env['TRACEROOT_GIT_REPO'],
      TRACEROOT_GIT_REF: process.env['TRACEROOT_GIT_REF'],
    };
    const origCwd = process.cwd();
    const messages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      messages.push(args.map(String).join(' '));
    };

    try {
      delete process.env['GITHUB_REPOSITORY'];
      delete process.env['GITHUB_SHA'];
      delete process.env['TRACEROOT_GIT_REPO'];
      delete process.env['TRACEROOT_GIT_REF'];
      // chdir to a fresh empty temp dir so both gitContextFromFiles() (reads
      // <cwd>/.git) and the git subprocess (rev-parse from a non-repo dir) find
      // nothing — regardless of whether this checkout is a worktree, a normal
      // clone, or a CI environment.
      process.chdir(mkdtempSync(path.join(os.tmpdir(), 'tr-nogit-')));
      TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true });
    } finally {
      process.chdir(origCwd);
      console.warn = origWarn;
      // Restore only what was set; leave unset vars deleted.
      if (saved.GITHUB_REPOSITORY === undefined) {
        delete process.env['GITHUB_REPOSITORY'];
      } else {
        process.env['GITHUB_REPOSITORY'] = saved.GITHUB_REPOSITORY;
      }
      if (saved.GITHUB_SHA === undefined) {
        delete process.env['GITHUB_SHA'];
      } else {
        process.env['GITHUB_SHA'] = saved.GITHUB_SHA;
      }
      if (saved.TRACEROOT_GIT_REPO === undefined) {
        delete process.env['TRACEROOT_GIT_REPO'];
      } else {
        process.env['TRACEROOT_GIT_REPO'] = saved.TRACEROOT_GIT_REPO;
      }
      if (saved.TRACEROOT_GIT_REF === undefined) {
        delete process.env['TRACEROOT_GIT_REF'];
      } else {
        process.env['TRACEROOT_GIT_REF'] = saved.TRACEROOT_GIT_REF;
      }
    }

    assert.ok(
      messages.some((m) => m.includes('git context incomplete')),
      `Expected a warn containing "git context incomplete", got: ${JSON.stringify(messages)}`,
    );
    assert.equal(
      messages.filter((m) => m.includes('git context incomplete')).length,
      1,
      'git-context warning should fire exactly once per initialize()',
    );
  });

  it('treats empty-string TRACEROOT_GIT_* env vars as unset (warns)', () => {
    const saved = {
      GITHUB_REPOSITORY: process.env['GITHUB_REPOSITORY'],
      GITHUB_SHA: process.env['GITHUB_SHA'],
      TRACEROOT_GIT_REPO: process.env['TRACEROOT_GIT_REPO'],
      TRACEROOT_GIT_REF: process.env['TRACEROOT_GIT_REF'],
    };
    const origCwd = process.cwd();
    const messages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      messages.push(args.map(String).join(' '));
    };
    try {
      delete process.env['GITHUB_REPOSITORY'];
      delete process.env['GITHUB_SHA'];
      // Empty strings must be treated as unset, not as resolved values.
      process.env['TRACEROOT_GIT_REPO'] = '';
      process.env['TRACEROOT_GIT_REF'] = '';
      process.chdir(mkdtempSync(path.join(os.tmpdir(), 'tr-nogit-')));
      TraceRoot.initialize({ apiKey: 'test-key', disableBatch: true });
    } finally {
      process.chdir(origCwd);
      console.warn = origWarn;
      for (const k of [
        'GITHUB_REPOSITORY',
        'GITHUB_SHA',
        'TRACEROOT_GIT_REPO',
        'TRACEROOT_GIT_REF',
      ] as const) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    assert.ok(
      messages.some((m) => m.includes('git context incomplete')),
      `Expected a warn for empty git env vars, got: ${JSON.stringify(messages)}`,
    );
  });
});

describe('initialize() internalExport projectId validation', () => {
  it('throws TypeError on an empty-string projectId', () => {
    try {
      assert.throws(
        () =>
          TraceRoot.initialize({
            internalExport: { path: '/api/v1/internal/traces', projectId: '' },
          }),
        TypeError,
      );
    } finally {
      _resetForTesting();
    }
  });
});

// Shared fixture for TraceRootSpanProcessor unit tests
function makeProcessorFixture() {
  const attributes: Record<string, unknown> = {};
  const span = {
    setAttribute: (k: string, v: unknown) => {
      attributes[k] = v;
    },
    setAttributes: (a: Record<string, unknown>) => {
      Object.assign(attributes, a);
    },
  } as unknown as import('@opentelemetry/api').Span;
  const inner = {
    onStart: () => {},
    onEnd: () => {},
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  } as unknown as import('@opentelemetry/sdk-trace-base').SimpleSpanProcessor;
  const ctx = {} as import('@opentelemetry/api').Context;
  return { span, inner, attributes, ctx };
}

describe('TraceRootSpanProcessor', () => {
  it('stamps deployment.environment on spans when environment is set', () => {
    const { span, inner, attributes, ctx } = makeProcessorFixture();
    const processor = new TraceRootSpanProcessor(inner, { environment: 'prod' });
    processor.onStart(span, ctx);
    assert.equal(attributes['deployment.environment'], 'prod');
    assert.equal(attributes['traceroot.sdk.name'], 'traceroot-ts');
  });

  it('stamps traceroot.git.repo and traceroot.git.ref with exact key names', () => {
    const { span, inner, attributes, ctx } = makeProcessorFixture();
    const processor = new TraceRootSpanProcessor(inner, {
      gitRepo: 'org/repo',
      gitRef: 'abc1234abc1234abc1234abc1234abc1234abc123',
    });
    processor.onStart(span, ctx);
    assert.equal(attributes['traceroot.git.repo'], 'org/repo');
    assert.equal(attributes['traceroot.git.ref'], 'abc1234abc1234abc1234abc1234abc1234abc123');
  });

  it('does not stamp deployment.environment when environment is not set', () => {
    const { span, inner, attributes, ctx } = makeProcessorFixture();
    const processor = new TraceRootSpanProcessor(inner);
    processor.onStart(span, ctx);
    assert.equal(Object.prototype.hasOwnProperty.call(attributes, 'deployment.environment'), false);
  });

  it('stamps traceroot.environment alongside deployment.environment when environment is set', () => {
    const { span, inner, attributes, ctx } = makeProcessorFixture();
    const processor = new TraceRootSpanProcessor(inner, { environment: 'prod' });
    processor.onStart(span, ctx);
    assert.equal(attributes['deployment.environment'], 'prod');
    assert.equal(attributes['traceroot.environment'], 'prod');
  });

  it('does not stamp traceroot.environment when environment is not set', () => {
    const { span, inner, attributes, ctx } = makeProcessorFixture();
    const processor = new TraceRootSpanProcessor(inner);
    processor.onStart(span, ctx);
    assert.equal(Object.prototype.hasOwnProperty.call(attributes, 'traceroot.environment'), false);
  });

  it('stamps every key of globalAttributes on the span', () => {
    const { span, inner, attributes, ctx } = makeProcessorFixture();
    const processor = new TraceRootSpanProcessor(inner, {
      globalAttributes: { 'traceroot.source': 'detector', 'traceroot.tier': 1 },
    });
    processor.onStart(span, ctx);
    assert.equal(attributes['traceroot.source'], 'detector');
    assert.equal(attributes['traceroot.tier'], 1);
  });

  it('does not stamp global attributes when globalAttributes is not set', () => {
    const { span, inner, attributes, ctx } = makeProcessorFixture();
    const processor = new TraceRootSpanProcessor(inner);
    processor.onStart(span, ctx);
    assert.equal(Object.prototype.hasOwnProperty.call(attributes, 'traceroot.source'), false);
  });
});

describe('resolveExportTarget()', () => {
  const sdkHeaders = { 'x-traceroot-sdk-name': 'traceroot-ts', 'x-traceroot-sdk-version': '9.9.9' };

  it('public mode: public traces path + Bearer auth', () => {
    const t = resolveExportTarget('https://app.traceroot.ai', 'key-123', sdkHeaders, undefined);
    assert.equal(t.url, 'https://app.traceroot.ai/api/v1/public/traces');
    assert.equal(t.headers['Authorization'], 'Bearer key-123');
    assert.equal(t.internal, false);
  });

  it('public mode without an apiKey: no Authorization header', () => {
    const t = resolveExportTarget('https://app.traceroot.ai', undefined, sdkHeaders, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(t.headers, 'Authorization'), false);
    assert.equal(t.internal, false);
  });

  it('internal mode: bare baseUrl+path with X-Project-Id header, no Authorization', () => {
    // The OTLP exporter strips query strings from its endpoint URL, so the URL
    // must stay query-free and the project id must ride as a header.
    const t = resolveExportTarget('https://internal.example', 'ignored', sdkHeaders, {
      path: '/api/v1/internal/traces',
      projectId: 'proj_123',
      headers: { 'X-Internal-Secret': 's3cr3t' },
    });
    assert.equal(t.url, 'https://internal.example/api/v1/internal/traces');
    assert.equal(t.url.includes('?'), false);
    assert.equal(t.headers['X-Project-Id'], 'proj_123');
    assert.equal(t.headers['X-Internal-Secret'], 's3cr3t');
    assert.equal(t.headers['x-traceroot-sdk-name'], 'traceroot-ts');
    assert.equal(Object.prototype.hasOwnProperty.call(t.headers, 'Authorization'), false);
    assert.equal(t.internal, true);
  });

  it('caller-supplied X-Project-Id overrides the projectId option (pinned ordering)', () => {
    const t = resolveExportTarget('https://h', undefined, sdkHeaders, {
      path: '/i',
      projectId: 'from-option',
      headers: { 'X-Project-Id': 'from-headers' },
    });
    assert.equal(t.headers['X-Project-Id'], 'from-headers');
  });

  it('SDK identity headers win over caller-supplied collisions', () => {
    const t = resolveExportTarget('https://h', undefined, sdkHeaders, {
      path: '/i',
      projectId: 'p',
      headers: { 'x-traceroot-sdk-name': 'imposter' },
    });
    assert.equal(t.headers['x-traceroot-sdk-name'], 'traceroot-ts');
  });

  it('preserves multiple custom headers alongside SDK headers', () => {
    const t = resolveExportTarget('https://h', undefined, sdkHeaders, {
      path: '/i',
      projectId: 'p',
      headers: { 'X-Internal-Secret': 's', 'X-Trace-Origin': 'worker', 'X-Region': 'us-east-1' },
    });
    assert.equal(t.headers['X-Internal-Secret'], 's');
    assert.equal(t.headers['X-Trace-Origin'], 'worker');
    assert.equal(t.headers['X-Region'], 'us-east-1');
    assert.equal(t.headers['x-traceroot-sdk-version'], '9.9.9');
  });

  describe('resolveExportTarget without a default projectId', () => {
    it('omits X-Project-Id when internalExport.projectId is unset', () => {
      const target = resolveExportTarget(
        'https://app.example.com',
        undefined,
        { 'x-traceroot-sdk-name': 'traceroot-ts' },
        { path: '/api/v1/internal/traces', headers: { 'X-Internal-Secret': 's' } },
      );
      assert.equal(target.internal, true);
      assert.equal(Object.prototype.hasOwnProperty.call(target.headers, 'X-Project-Id'), false);
      assert.equal(target.headers['X-Internal-Secret'], 's');
    });

    it('still sends X-Project-Id when configured', () => {
      const target = resolveExportTarget(
        'https://app.example.com',
        undefined,
        {},
        { path: '/api/v1/internal/traces', projectId: 'proj-default' },
      );
      assert.equal(target.headers['X-Project-Id'], 'proj-default');
    });
  });
});

describe('internal export mode init', () => {
  const FORCED = '11111111111111111111111111111111';

  afterEach(() => {
    _resetForTesting();
  });

  it('isInternalMode() is false in public mode', () => {
    TraceRoot.initialize({ apiKey: 'k', disableBatch: true });
    assert.equal(isInternalMode(), false);
  });

  it('isInternalMode() is true after internal init, false after reset', () => {
    TraceRoot.initialize({
      internalExport: { path: '/api/v1/internal/traces', projectId: 'proj_1' },
    });
    assert.equal(isInternalMode(), true);
    _resetForTesting();
    assert.equal(isInternalMode(), false);
  });

  it('wires the resolved target into the exporter config (public regression + internal)', () => {
    TraceRoot.initialize({ apiKey: 'k', disableBatch: true });
    let t = _getExportTargetForTesting();
    assert.ok(t);
    assert.ok(t.url.endsWith('/api/v1/public/traces'));
    assert.equal(t.headers['Authorization'], 'Bearer k');
    _resetForTesting();

    TraceRoot.initialize({
      internalExport: {
        path: '/api/v1/internal/traces',
        projectId: 'proj_1',
        headers: { 'X-Internal-Secret': 's' },
      },
    });
    t = _getExportTargetForTesting();
    assert.ok(t);
    assert.ok(t.url.endsWith('/api/v1/internal/traces'));
    assert.equal(t.headers['X-Project-Id'], 'proj_1');
    assert.equal(t.headers['X-Internal-Secret'], 's');
    assert.equal(Object.prototype.hasOwnProperty.call(t.headers, 'Authorization'), false);
  });

  it('does not warn about a missing API key in internal mode', () => {
    const messages: string[] = [];
    const restore = console.warn;
    console.warn = (...a: unknown[]) => {
      messages.push(a.map(String).join(' '));
    };
    try {
      TraceRoot.initialize({
        internalExport: { path: '/api/v1/internal/traces', projectId: 'proj_1' },
      });
    } finally {
      console.warn = restore;
    }
    assert.equal(
      messages.some((m) => m.includes('No API key')),
      false,
    );
  });

  it('installs the forcing generator in internal mode only (defense in depth)', () => {
    // Internal init: the globally registered provider carries ContextIdGenerator,
    // so a root created inside a forced scope gets the forced id. Default batching
    // means these spans are buffered and never exported — no network.
    TraceRoot.initialize({
      internalExport: { path: '/api/v1/internal/traces', projectId: 'p' },
    });
    const forced = withForcedTraceId(FORCED, () => trace.getTracer('t').startSpan('root'));
    assert.equal(forced.spanContext().traceId, FORCED);
    forced.end();
    _resetForTesting();

    // Public init: no ContextIdGenerator — even a bypassed gate cannot force.
    TraceRoot.initialize({ apiKey: 'k' });
    const unforced = withForcedTraceId(FORCED, () => trace.getTracer('t').startSpan('root'));
    assert.notEqual(unforced.spanContext().traceId, FORCED);
    unforced.end();
  });
});
