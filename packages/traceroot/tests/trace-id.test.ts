import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidTraceId,
  ContextIdGenerator,
  isInternalMode,
  shouldForceTraceId,
  withForcedTraceId,
  _resetTraceIdState,
  _setInternalMode,
} from '../src/trace-id';

const VALID = 'abcdef0123456789abcdef0123456789';

describe('assertValidTraceId()', () => {
  it('accepts a lowercase 32-hex id', () => {
    assert.doesNotThrow(() => assertValidTraceId(VALID));
  });
  it('throws on wrong length', () => {
    assert.throws(() => assertValidTraceId('abcd'), TypeError);
  });
  it('throws on uppercase', () => {
    assert.throws(() => assertValidTraceId(VALID.toUpperCase()), TypeError);
  });
  it('throws on non-hex characters', () => {
    assert.throws(() => assertValidTraceId('g'.repeat(32)), TypeError);
  });
  it('throws on the all-zero sentinel', () => {
    assert.throws(() => assertValidTraceId('0'.repeat(32)), TypeError);
  });
});

describe('ContextIdGenerator', () => {
  it('generates random 32-hex trace ids outside a forced scope', () => {
    const g = new ContextIdGenerator();
    const a = g.generateTraceId();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, g.generateTraceId());
  });

  it('returns the forced id inside a withForcedTraceId scope', () => {
    const g = new ContextIdGenerator();
    assert.equal(
      withForcedTraceId(VALID, () => g.generateTraceId()),
      VALID,
    );
  });

  it('span ids are random 16-hex even inside a forced scope', () => {
    const g = new ContextIdGenerator();
    const sid = withForcedTraceId(VALID, () => g.generateSpanId());
    assert.match(sid, /^[0-9a-f]{16}$/);
  });

  it('does not leak: random again after the scope returns', () => {
    const g = new ContextIdGenerator();
    withForcedTraceId(VALID, () => g.generateTraceId());
    assert.notEqual(g.generateTraceId(), VALID);
  });

  it('interleaved async scopes each keep their own id', async () => {
    const g = new ContextIdGenerator();
    const A = 'a'.repeat(32);
    const B = 'b'.repeat(32);
    const run = (id: string) =>
      withForcedTraceId(id, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return g.generateTraceId();
      });
    const [ra, rb] = await Promise.all([run(A), run(B)]);
    assert.equal(ra, A);
    assert.equal(rb, B);
  });
});

describe('shouldForceTraceId() gating', () => {
  afterEach(() => {
    _setInternalMode(false);
    _resetTraceIdState();
  });

  it('returns true in internal mode', () => {
    _setInternalMode(true);
    assert.equal(shouldForceTraceId(VALID), true);
  });

  it('warns and returns false outside internal mode', () => {
    const messages: string[] = [];
    const restore = console.warn;
    console.warn = (...a: unknown[]) => {
      messages.push(a.map(String).join(' '));
    };
    let result: boolean | undefined;
    try {
      result = shouldForceTraceId(VALID);
    } finally {
      console.warn = restore;
    }
    assert.equal(result, false);
    assert.ok(messages.some((m) => m.includes('internal export mode')));
  });

  it('validates before gating: malformed id throws even outside internal mode', () => {
    assert.throws(() => shouldForceTraceId('nope'), TypeError);
  });

  it('warns only once for repeated ignored forced ids', () => {
    const messages: string[] = [];
    const restore = console.warn;
    console.warn = (...a: unknown[]) => {
      messages.push(a.map(String).join(' '));
    };
    try {
      shouldForceTraceId(VALID);
      shouldForceTraceId(VALID);
      shouldForceTraceId(VALID);
    } finally {
      console.warn = restore;
    }
    assert.equal(messages.filter((m) => m.includes('internal export mode')).length, 1);
  });

  it('isInternalMode() reflects the setter', () => {
    assert.equal(isInternalMode(), false);
    _setInternalMode(true);
    assert.equal(isInternalMode(), true);
  });
});

describe('assertValidTraceId() edge cases', () => {
  it('rejects ids with surrounding whitespace', () => {
    assert.throws(() => assertValidTraceId(` ${'a'.repeat(31)}`), TypeError);
    assert.throws(() => assertValidTraceId(`${'a'.repeat(31)} `), TypeError);
  });

  it('rejects 0x-prefixed ids', () => {
    assert.throws(() => assertValidTraceId(`0x${'a'.repeat(30)}`), TypeError);
  });
});

describe('withForcedTraceId() nesting', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);

  it('innermost nested forced scope wins', () => {
    const g = new ContextIdGenerator();
    const got = withForcedTraceId(A, () => withForcedTraceId(B, () => g.generateTraceId()));
    assert.equal(got, B);
  });

  it('outer forced scope is restored after the inner scope exits', () => {
    const g = new ContextIdGenerator();
    const got = withForcedTraceId(A, () => {
      withForcedTraceId(B, () => g.generateTraceId());
      return g.generateTraceId();
    });
    assert.equal(got, A);
  });
});
