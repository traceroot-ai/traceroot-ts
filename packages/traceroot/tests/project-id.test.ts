// Unit tests for per-root project attribution: validation, internal-mode gating,
// and the OTel-context carry helpers.
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import {
  assertValidProjectId,
  contextWithProjectId,
  projectIdFromContext,
  shouldAttachProjectId,
  _resetProjectIdState,
} from '../src/project-id';
import { _setInternalMode } from '../src/trace-id';

afterEach(() => {
  _setInternalMode(false);
  _resetProjectIdState();
  mock.restoreAll();
});

describe('assertValidProjectId', () => {
  it('accepts a non-empty string', () => {
    assert.doesNotThrow(() => assertValidProjectId('proj-1'));
  });

  it('throws TypeError on empty string and non-strings', () => {
    assert.throws(() => assertValidProjectId(''), TypeError);
    assert.throws(() => assertValidProjectId(123), TypeError);
    assert.throws(() => assertValidProjectId(undefined), TypeError);
    assert.throws(() => assertValidProjectId(null), TypeError);
  });
});

describe('shouldAttachProjectId', () => {
  it('returns true in internal mode', () => {
    _setInternalMode(true);
    assert.equal(shouldAttachProjectId('proj-1'), true);
  });

  it('warns once and returns false in public mode', () => {
    const warn = mock.method(console, 'warn', () => {});
    assert.equal(shouldAttachProjectId('proj-1'), false);
    assert.equal(shouldAttachProjectId('proj-2'), false);
    assert.equal(warn.mock.callCount(), 1);
  });

  it('throws on malformed ids in ANY mode', () => {
    assert.throws(() => shouldAttachProjectId(''), TypeError);
    _setInternalMode(true);
    assert.throws(() => shouldAttachProjectId(''), TypeError);
  });
});

describe('context carry', () => {
  it('round-trips through the context and leaves the base context untouched', () => {
    const ctx = contextWithProjectId(ROOT_CONTEXT, 'proj-1');
    assert.equal(projectIdFromContext(ctx), 'proj-1');
    assert.equal(projectIdFromContext(ROOT_CONTEXT), undefined);
  });
});
