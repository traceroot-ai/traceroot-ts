import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpanAttributes } from '../src/index';

describe('SpanAttributes', () => {
  it('is exported from the package index', () => {
    assert.ok(SpanAttributes !== undefined);
    assert.equal(typeof SpanAttributes, 'object');
  });

  it('has span-level attribute keys', () => {
    assert.equal(SpanAttributes.SPAN_METADATA, 'traceroot.span.metadata');
    assert.equal(SpanAttributes.SPAN_TAGS, 'traceroot.span.tags');
  });

  it('has LLM-specific attribute keys', () => {
    assert.equal(SpanAttributes.LLM_MODEL, 'traceroot.llm.model');
    assert.equal(SpanAttributes.LLM_MODEL_PARAMETERS, 'traceroot.llm.model_parameters');
    assert.equal(SpanAttributes.LLM_USAGE, 'traceroot.llm.usage');
    assert.equal(SpanAttributes.LLM_PROMPT, 'traceroot.llm.prompt');
  });

  it('has trace-level attribute keys', () => {
    assert.equal(SpanAttributes.TRACE_METADATA, 'traceroot.trace.metadata');
    assert.equal(SpanAttributes.TRACE_TAGS, 'traceroot.trace.tags');
  });

  it('has git context attribute keys', () => {
    assert.equal(SpanAttributes.GIT_SOURCE_FILE, 'traceroot.git.source_file');
    assert.equal(SpanAttributes.GIT_SOURCE_LINE, 'traceroot.git.source_line');
    assert.equal(SpanAttributes.GIT_SOURCE_FUNCTION, 'traceroot.git.source_function');
  });
});
