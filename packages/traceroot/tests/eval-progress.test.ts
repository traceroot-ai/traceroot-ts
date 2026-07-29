// Console progress reporter + auto-detection parity (Python test_progress.py).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConsoleProgress, canAnimate, shouldShowProgress } from '../src/eval/progress';
import type { EvalItemResult, Score } from '../src/eval';

function item(caseId: string, value: number | 'error' | null): EvalItemResult {
  const scores: Score[] =
    value !== null && value !== 'error'
      ? [{ name: 'acc', value, comment: null, metadata: null }]
      : [];
  return {
    caseId,
    input: null,
    output: null,
    expected: null,
    scores,
    scorerErrors: {},
    error: value === 'error' ? 'boom' : null,
    traceId: null,
    durationMs: null,
  };
}

class Buffer {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

describe('shouldShowProgress', () => {
  it('explicit value wins over env and TTY', () => {
    const prev = process.env.TRACEROOT_EVAL_PROGRESS;
    process.env.TRACEROOT_EVAL_PROGRESS = '0';
    try {
      assert.equal(shouldShowProgress(true), true);
      assert.equal(shouldShowProgress(false), false);
    } finally {
      if (prev === undefined) delete process.env.TRACEROOT_EVAL_PROGRESS;
      else process.env.TRACEROOT_EVAL_PROGRESS = prev;
    }
  });

  it('env=0 disables auto-detect', () => {
    const prev = process.env.TRACEROOT_EVAL_PROGRESS;
    process.env.TRACEROOT_EVAL_PROGRESS = '0';
    try {
      assert.equal(shouldShowProgress(undefined), false);
    } finally {
      if (prev === undefined) delete process.env.TRACEROOT_EVAL_PROGRESS;
      else process.env.TRACEROOT_EVAL_PROGRESS = prev;
    }
  });
});

describe('ConsoleProgress', () => {
  it('counts statuses and renders an in-place bar', () => {
    const buf = new Buffer();
    const bar = new ConsoleProgress(3, 'demo', { stream: buf, width: 10, animate: true });
    bar.start();
    bar.onCaseComplete(item('a', 1.0), 5); // passed
    bar.onCaseComplete(item('b', 0.0), 5); // failed
    bar.onCaseComplete(item('c', 'error'), 5); // errored
    bar.finish();

    assert.deepEqual([bar.passed, bar.failed, bar.errored, bar.done], [1, 1, 1, 3]);
    const out = buf.text;
    assert.match(out, /demo/);
    assert.match(out, /3\/3/);
    assert.match(out, /off/); // "N off" tail once a case fails/errors
    assert.ok(out.endsWith('\r\x1b[2K')); // finish() clears the line (CR + erase-line)
  });

  it('finish() without start() is a no-op', () => {
    const buf = new Buffer();
    const bar = new ConsoleProgress(0, 'empty', { stream: buf });
    bar.finish();
    assert.equal(buf.text, '');
  });

  it('never renders wider than the terminal (would wrap and stack)', () => {
    // A long run name in a narrow (40-col) terminal must fit on one physical row, or
    // \r\x1b[2K can't clear it and the overflow stacks (the VS Code terminal bug).
    const buf = new Buffer();
    const bar = new ConsoleProgress(6, 'ticket-routing-quality-v2', {
      stream: buf,
      animate: true,
      cols: 40,
    });
    bar.start();
    for (let i = 0; i < 6; i++) bar.onCaseComplete(item(`c${i}`, 1.0), 5);
    const frames = buf.text.split('\r\x1b[2K').filter((f) => f.length > 0);
    assert.ok(frames.length > 0, 'expected at least one rendered frame');
    for (const line of frames) {
      assert.ok(
        line.length <= 39,
        `frame wider than terminal (would wrap): ${JSON.stringify(line)}`,
      );
    }
    // The bar + counts (the actual progress) stay visible even when the label is ellipsized.
    const last = frames[frames.length - 1];
    assert.ok(last.includes('…') && last.includes('6/6') && last.includes('█'));
  });

  it('keeps the full line when the terminal is wide enough', () => {
    const buf = new Buffer();
    const bar = new ConsoleProgress(3, 'demo', {
      stream: buf,
      width: 10,
      animate: true,
      cols: 200,
    });
    bar.start();
    bar.onCaseComplete(item('a', 1.0), 5);
    const out = buf.text;
    assert.match(out, /demo/);
    assert.match(out, /1\/3/);
    assert.match(out, /\/s/); // stats survive, nothing trimmed
  });
});

describe('ConsoleProgress plain fallback', () => {
  it('plain mode writes clean newline lines (no CR/ANSI, cannot stack)', () => {
    const buf = new Buffer();
    const bar = new ConsoleProgress(3, 'demo', { stream: buf, animate: false }); // e.g. Debug Console
    bar.start();
    bar.onCaseComplete(item('a', 1.0), 5);
    bar.onCaseComplete(item('b', 0.0), 5);
    bar.onCaseComplete(item('c', 'error'), 5);
    bar.finish();
    const out = buf.text;
    assert.ok(!out.includes('\r') && !out.includes('\x1b')); // no CR/ANSI -> cannot stack
    assert.match(out, /3\/3/);
    assert.equal((out.match(/\n/g) || []).length, 3); // one clean line per case (small run)
  });

  it('canAnimate is false when the VS Code JS debugger is attached', () => {
    const prev = process.env.VSCODE_INSPECTOR_OPTIONS;
    process.env.VSCODE_INSPECTOR_OPTIONS = '{}';
    try {
      assert.equal(canAnimate(), false);
    } finally {
      if (prev === undefined) delete process.env.VSCODE_INSPECTOR_OPTIONS;
      else process.env.VSCODE_INSPECTOR_OPTIONS = prev;
    }
  });
});
