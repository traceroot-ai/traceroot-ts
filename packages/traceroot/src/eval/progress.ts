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

/** A single-line, in-place progress bar for an evaluation run. */
export class ConsoleProgress {
  readonly total: number;
  readonly label: string;
  private readonly stream: ProgressStream;
  private readonly width: number;
  done = 0;
  passed = 0;
  failed = 0;
  errored = 0;
  private t0 = 0;
  private active = false;

  constructor(
    total: number,
    label: string,
    opts: { stream?: ProgressStream; width?: number } = {},
  ) {
    this.total = Math.max(Math.trunc(total), 0);
    this.label = label;
    this.stream = opts.stream ?? (process.stderr as unknown as ProgressStream);
    this.width = opts.width ?? 24;
  }

  // -- lifecycle -------------------------------------------------------
  start(): void {
    this.t0 = nowMs();
    this.active = true;
    this.render();
  }

  onCaseComplete(item: EvalItemResult, _durationMs: number): void {
    this.done += 1;
    const status = caseStatus(item);
    if (status === 'passed') this.passed += 1;
    else if (status === 'failed') this.failed += 1;
    else if (status === 'errored') this.errored += 1;
    this.render();
  }

  /** Erase the bar so the caller's own output starts on a clean line. */
  finish(): void {
    if (!this.active) return;
    this.stream.write('\r\x1b[2K'); // CR + clear whole line
    this.active = false;
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
    const line =
      `  ${this.label}  ▕${this.bar(frac)}▏ ${this.done}/${this.total}` +
      `  ·  ${rate.toFixed(1)}/s  ·  ${mm}:${String(ss).padStart(2, '0')}${tail}`;
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
