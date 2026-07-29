// src/eval/progress.ts — dependency-free console progress reporter for eval runs.
//
// Renders a live, single-line progress bar to a stream (stderr by default) as
// cases complete, then clears it. It is driven entirely by the engine's
// existing onCaseStart / onCaseComplete hooks, so it adds no coupling to the
// run logic. Nothing here is uploaded — purely local presentation.
//
// The engine turns this on automatically when stdout is an interactive terminal
// and off when output is piped/redirected (CI, the CLI runner, a subprocess),
// so machine-readable channels stay clean. Callers can force it with
// evaluate({ progress: true | false }).

import { caseStatus, type EvalItemResult } from './results';

// Eighth-block glyphs for a smooth sub-cell bar edge.
const BLOCKS = ' ▏▎▍▌▋▊▉█';

/** A minimal write target (Node stream or a test buffer). */
export interface ProgressStream {
  write(chunk: string): unknown;
  /** Terminal width, when the stream is a TTY (Node WriteStream exposes it). */
  columns?: number;
}

/**
 * Best-effort terminal width (columns) for `stream`, default 80. The animated bar MUST fit
 * on one physical row: a frame wider than the terminal wraps, and `\r\x1b[2K` then only
 * clears the last wrapped row — leaving the overflow behind on every frame (the "stacking"
 * bug). We clamp the rendered line to this width so it never wraps.
 */
function termCols(stream: ProgressStream): number {
  const fromStream = stream.columns;
  if (typeof fromStream === 'number' && fromStream > 0) return fromStream;
  const fromStderr = typeof process !== 'undefined' ? process.stderr?.columns : undefined;
  if (typeof fromStderr === 'number' && fromStderr > 0) return fromStderr;
  return 80;
}

/**
 * Compose one progress line that fits within `limit` columns without wrapping. Keeps the bar
 * + counts (`anchor`) visible at all costs — a progress bar with no progress is useless.
 * Shedding order as space runs out: full line -> drop `stats` -> ellipsize `label` ->
 * (last resort) hard-trim. `label` sits before the anchor, `stats` after it.
 */
function fitLine(label: string, anchor: string, stats: string, limit: number): string {
  const full = `  ${label}${anchor}${stats}`;
  if (full.length <= limit) return full;
  const withLabel = `  ${label}${anchor}`;
  if (withLabel.length <= limit) return withLabel; // dropping stats is enough
  const room = limit - anchor.length - 2; // 2 leading spaces + label + anchor
  if (room >= 1) {
    const lab = label.length <= room ? label : label.slice(0, Math.max(room - 1, 0)) + '…';
    return `  ${lab}${anchor}`;
  }
  return withLabel.slice(0, limit); // too narrow for even the bare anchor: hard-trim
}

/**
 * Resolve the effective progress setting. `explicit` wins when defined.
 * Otherwise auto-detect: on only for an interactive stdout, and suppressible
 * via TRACEROOT_EVAL_PROGRESS=0.
 */
export function shouldShowProgress(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  if (typeof process === 'undefined') return false;
  if (process.env?.TRACEROOT_EVAL_PROGRESS === '0') return false;
  // Gate on the bar's own stream (stderr): show even when stdout is piped, and stay
  // suppressed when stderr is captured (e.g. some IDE run panels) so it can't stack.
  return process.stderr?.isTTY === true;
}

/** Print a clickable run link on its own line (same stream as the bar). */
export function printRunUrl(url: string, stream?: ProgressStream): void {
  (stream ?? (process.stderr as unknown as ProgressStream)).write(`  → ${url}\n`);
}

/**
 * Whether `process.stderr` supports an in-place (\r/ANSI) redraw. False for pipes,
 * TERM=dumb, and the VS Code Debug Console (which doesn't honor carriage returns even when
 * isTTY is spoofed) — there the reporter uses plain newline progress instead of animating.
 */
export function canAnimate(): boolean {
  if (typeof process === 'undefined') return false;
  if (process.stderr?.isTTY !== true) return false;
  if (process.env?.TERM === 'dumb') return false;
  // VS Code JS debugger (Debug Console) sets this; its console doesn't process \r.
  if (process.env?.VSCODE_INSPECTOR_OPTIONS !== undefined) return false;
  return true;
}

/**
 * Evaluation progress: an animated single-line bar where the terminal supports it, and
 * clean (non-stacking) plain newline updates everywhere else (Debug Console, dumb term).
 */
export class ConsoleProgress {
  readonly total: number;
  readonly label: string;
  private readonly stream: ProgressStream;
  private readonly width: number;
  private readonly animateMode: boolean;
  private readonly cols?: number;
  done = 0;
  passed = 0;
  failed = 0;
  errored = 0;
  private t0 = 0;
  private active = false;

  constructor(
    total: number,
    label: string,
    opts: { stream?: ProgressStream; width?: number; animate?: boolean; cols?: number } = {},
  ) {
    this.total = Math.max(Math.trunc(total), 0);
    this.label = label;
    this.stream = opts.stream ?? (process.stderr as unknown as ProgressStream);
    this.width = opts.width ?? 24;
    this.animateMode = opts.animate ?? canAnimate();
    this.cols = opts.cols; // terminal width to clamp frames to (auto-detected when undefined)
  }

  // -- lifecycle -------------------------------------------------------
  start(): void {
    this.t0 = nowMs();
    this.active = true;
    if (this.animateMode) this.render();
  }

  onCaseComplete(item: EvalItemResult, _durationMs: number): void {
    this.done += 1;
    const status = caseStatus(item);
    if (status === 'passed') this.passed += 1;
    else if (status === 'failed') this.failed += 1;
    else if (status === 'errored') this.errored += 1;
    if (this.animateMode) this.render();
    else this.plain();
  }

  /** Erase the animated bar so the caller's output starts clean. No-op in plain mode. */
  finish(): void {
    if (!this.active) return;
    if (this.animateMode) this.stream.write('\r\x1b[2K'); // CR + clear whole line
    this.active = false;
  }

  /** A clean newline-terminated line (no \r/ANSI). Throttled to ~deciles for large runs. */
  private plain(): void {
    const step = Math.max(1, Math.trunc(this.total / 10));
    if (this.done === this.total || this.total <= 20 || this.done % step === 0) {
      const bad = this.failed + this.errored;
      const tail = bad > 0 ? `  (${bad} off)` : '';
      this.stream.write(`  ${this.label}  ${this.done}/${this.total}${tail}\n`);
    }
  }

  // -- rendering -------------------------------------------------------
  private bar(frac: number): string {
    const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const filled = f * this.width;
    const full = Math.trunc(filled);
    let bar = '█'.repeat(full);
    if (full < this.width) {
      bar += BLOCKS[Math.trunc((filled - full) * 8)];
      bar += ' '.repeat(this.width - full - 1);
    }
    return bar;
  }

  private render(): void {
    if (!this.active) return;
    const total = this.total || 1;
    const frac = this.done / total;
    const elapsed = (nowMs() - this.t0) / 1000;
    const rate = elapsed > 0 ? this.done / elapsed : 0;
    const mm = Math.trunc(elapsed / 60);
    const ss = Math.trunc(elapsed % 60);
    const badCount = this.failed + this.errored;
    const tail = badCount > 0 ? `  ${badCount} off` : '';
    // Clamp to one physical row: a line wider than the terminal wraps, and then \r\x1b[2K
    // only clears the last wrapped row -> the overflow stacks. Trim to cols-1 (leave the
    // last column free so an exactly-full line can't auto-wrap).
    const limit = Math.max((this.cols ?? termCols(this.stream)) - 1, 0);
    const anchor = `  ▕${this.bar(frac)}▏ ${this.done}/${this.total}`; // bar + counts (kept)
    const stats = `  ·  ${rate.toFixed(1)}/s  ·  ${mm}:${String(ss).padStart(2, '0')}${tail}`;
    const line = fitLine(this.label, anchor, stats, limit);
    // \r returns to column 0; \x1b[2K erases the whole line -> clean in-place redraw.
    this.stream.write('\r\x1b[2K' + line);
  }
}

// Wall-clock is only used for the throughput/elapsed readout; a coarse source
// is fine and keeps this free of injected clocks.
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
