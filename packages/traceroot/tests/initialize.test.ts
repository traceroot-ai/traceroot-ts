import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceRoot, _resetForTesting } from '../src/traceroot';
import { TraceRootSpanProcessor } from '../src/processor';

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
