import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRoot, _resetForTesting } from '../src/traceroot';

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
    console.warn = (...args: unknown[]) => { messages.push(args.join(' ')); };
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
    console.warn = (...args: unknown[]) => { messages.push(args.join(' ')); };
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
});
