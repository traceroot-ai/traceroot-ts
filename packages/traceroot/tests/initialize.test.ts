import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
