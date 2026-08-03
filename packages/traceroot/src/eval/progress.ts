// src/eval/progress.ts — dependency-free console progress reporter for eval runs.
//
// Renders a live, single-line progress bar to a stream (stderr by default) as
// cases complete, then clears it. It is driven entirely by the engine's
// existing onCaseStart / onCaseComplete hooks, so it adds no coupling to the
// run logic. Nothing here is uploaded — purely local presentation.
//
// The engine turns this on automatically when stdout is an interactive terminal
// and off when output is piped/redirected (CI, the runner, a subprocess),
// so machine-readable channels stay clean. Callers can force it with
// evaluate({ progress: true | false }).

import { caseStatus, MainScore, type EvalItemResult } from './results';

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

/** Terminal columns for one code point: C0/C1 controls & zero-width/combining marks = 0,
 *  East Asian Wide/Fullwidth (incl. most emoji) = 2, everything else = 1. Best-effort (no full
 *  Unicode width DB) but enough to keep CJK/emoji/combining input from wrapping the single line. */
function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0 / C1 controls
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space .. RLM
    cp === 0xfeff || // zero-width no-break space
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) || // CJK extension B+
    isWideEmojiBmp(cp) // scattered wide emoji in the BMP (e.g. ⏰ U+23F0)
  ) {
    return 2;
  }
  return 1;
}

// Emoji-presentation code points in the BMP that terminals render double-width (from the Unicode
// emoji width data). These are scattered outside the CJK blocks above, so listing them explicitly
// avoids widening the common width-1 symbols that share those blocks (e.g. ✓ U+2713, → U+2192).
const WIDE_EMOJI_BMP: [number, number][] = [
  [0x231a, 0x231b],
  [0x23e9, 0x23fa], // ⏩ .. ⏺ (incl. ⏰ U+23F0, ⏳ U+23F3)
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
];

function isWideEmojiBmp(cp: number): boolean {
  for (const [lo, hi] of WIDE_EMOJI_BMP) {
    if (cp >= lo && cp <= hi) return true;
    if (cp < lo) break; // ranges are sorted ascending
  }
  return false;
}

/** Display width of a string in terminal columns (surrogate-pair aware). */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) as number);
  return w;
}

/** Truncate to at most `maxCols` display columns, never splitting a code point. */
function sliceToWidth(s: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) as number);
    if (w + cw > maxCols) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** Strip C0/C1 controls (newlines, ANSI escapes, etc.) so a run name can't break the
 *  single-line reporter or emit stray terminal control sequences. */
function sanitizeLabel(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
}

/**
 * Compose one progress line that fits within `limit` columns without wrapping. Keeps the bar
 * + counts (`anchor`) visible at all costs — a progress bar with no progress is useless.
 * Shedding order as space runs out: full line -> drop `stats` -> ellipsize `label` ->
 * (last resort) trim the anchor. Widths are display columns, so wide/zero-width characters
 * can't sneak past the clamp. `label` sits before the anchor, `stats` after it.
 */
function fitLine(label: string, anchor: string, stats: string, limit: number): string {
  const full = `  ${label}${anchor}${stats}`;
  if (displayWidth(full) <= limit) return full;
  const withLabel = `  ${label}${anchor}`;
  if (displayWidth(withLabel) <= limit) return withLabel; // dropping stats is enough
  const room = limit - displayWidth(anchor) - 2; // columns left for the label
  if (room >= 1) {
    const lab =
      displayWidth(label) <= room ? label : sliceToWidth(label, Math.max(room - 1, 0)) + '…';
    return `  ${lab}${anchor}`;
  }
  // Too narrow for even the bare anchor: keep the counts (drop the label) and trim the anchor
  // itself by display width so it still never wraps.
  return sliceToWidth(anchor, limit);
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

/**
 * Print a clickable run link on its own line, followed by a blank line to space it from the
 * next evaluate()'s output (same stream as the bar).
 */
export function printRunUrl(url: string, stream?: ProgressStream): void {
  (stream ?? (process.stderr as unknown as ProgressStream)).write(`  → ${url}\n\n`);
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
  // The run's resolved scoring policy, so live pass/fail matches the final result. null -> the
  // default policy (single-scorer default).
  private readonly mainScore: MainScore | null;
  done = 0;
  passed = 0;
  failed = 0;
  errored = 0;
  private t0 = 0;
  private active = false;

  constructor(
    total: number,
    label: string,
    opts: {
      stream?: ProgressStream;
      width?: number;
      animate?: boolean;
      cols?: number;
      mainScore?: MainScore | null;
    } = {},
  ) {
    this.total = Math.max(Math.trunc(total), 0);
    this.label = sanitizeLabel(label);
    this.stream = opts.stream ?? (process.stderr as unknown as ProgressStream);
    this.width = opts.width ?? 24;
    this.animateMode = opts.animate ?? canAnimate();
    this.cols = opts.cols; // terminal width to clamp frames to (auto-detected when undefined)
    this.mainScore = opts.mainScore ?? null;
  }

  // -- lifecycle -------------------------------------------------------
  start(): void {
    this.t0 = nowMs();
    this.active = true;
    if (this.animateMode) this.render();
  }

  onCaseComplete(item: EvalItemResult, _durationMs: number): void {
    this.done += 1;
    const status = caseStatus(item, this.mainScore);
    if (status === 'passed') this.passed += 1;
    else if (status === 'failed') this.failed += 1;
    else if (status === 'errored') this.errored += 1;
    if (this.animateMode) this.render();
    else this.plain();
  }

  /**
   * Persist the completed bar: redraw the final (100%) frame and end the line so it stays on
   * screen, then subsequent output starts cleanly below it. No-op in plain mode (its last
   * line already shows the final count and is newline-terminated).
   */
  finish(): void {
    if (!this.active) return;
    if (this.animateMode) this.stream.write('\r\x1b[2K' + this.frame() + '\n');
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

  /** The current progress line, clamped to one physical terminal row (no wrap). */
  private frame(): string {
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
    return fitLine(this.label, anchor, stats, limit);
  }

  private render(): void {
    if (!this.active) return;
    // \r returns to column 0; \x1b[2K erases the whole line -> clean in-place redraw.
    this.stream.write('\r\x1b[2K' + this.frame());
  }
}

// Wall-clock is only used for the throughput/elapsed readout; a coarse source
// is fine and keeps this free of injected clocks.
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
