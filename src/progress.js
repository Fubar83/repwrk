/**
 * Progress reporting for work whose size is known up front.
 *
 * Listing a large organisation is minutes of waiting on GitHub, and a CLI that
 * prints nothing for minutes is indistinguishable from one that has hung. The
 * meter exists to answer two questions while that happens: is it still moving,
 * and how much longer.
 */

const BAR_WIDTH = 24;

/**
 * The bar is drawn with box-drawing characters where the terminal can show
 * them, and with ASCII where it cannot. A Windows console still running a
 * legacy code page renders UTF-8 as mojibake, which is worse than plain.
 */
function barCharacters(stream) {
  const utf8 =
    process.platform !== 'win32' ||
    Boolean(process.env.WT_SESSION) ||
    process.env.TERM_PROGRAM === 'vscode' ||
    /utf-?8/i.test(process.env.LANG ?? '');
  return utf8 ? { full: '█', empty: '░' } : { full: '#', empty: '-' };
}

export function renderBar(done, total, { width = BAR_WIDTH, full = '█', empty = '░' } = {}) {
  // An unknown total draws an empty bar rather than a full one: nothing is
  // known to be finished, so nothing should look finished.
  const ratio = total > 0 ? Math.min(Math.max(done / total, 0), 1) : 0;
  const filled = Math.round(ratio * width);
  return `${full.repeat(filled)}${empty.repeat(width - filled)}`;
}

/** Whole seconds under a minute, m:ss above it — no decimals anyone would read. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Time left, guessed from the rate so far. Only offered once enough has
 * happened for the guess to mean anything — an estimate drawn from a single
 * page is noise, and a wrong number is worse than no number.
 */
export function estimateRemaining(done, total, elapsed) {
  if (done <= 0 || total <= 0 || done >= total || elapsed <= 0) return null;
  const remaining = ((total - done) * elapsed) / done;
  return remaining < 1500 ? null : remaining;
}

/**
 * A meter that redraws one line on a terminal, and degrades to occasional
 * plain lines when there is no terminal to redraw on.
 *
 * Everything goes to stderr: progress is not the output of the command, and a
 * script reading stdout must not have to strip it out.
 */
export class Progress {
  constructor(label, { stream = process.stderr, now = () => Date.now(), every = 1000 } = {}) {
    this.label = label;
    this.stream = stream;
    this.now = now;
    // How often a non-terminal is told anything, in items.
    this.every = every;
    this.tty = Boolean(stream.isTTY);
    this.chars = barCharacters(stream);
    this.started = now();
    this.done = 0;
    this.total = 0;
    this.drawn = false;
    this.reported = 0;
  }

  get elapsed() {
    return this.now() - this.started;
  }

  update(done, total = this.total) {
    this.done = done;
    this.total = total;
    if (this.tty) this.#draw();
    else this.#log();
  }

  #draw() {
    const bar = renderBar(this.done, this.total, this.chars);
    const count = this.total > 0 ? `${this.done}/${this.total}` : String(this.done);
    const remaining = estimateRemaining(this.done, this.total, this.elapsed);
    const eta = remaining === null ? '' : `, ${formatDuration(remaining)} left`;

    this.#clear();
    this.stream.write(`${this.label} ${bar} ${count}${eta}`);
    this.drawn = true;
  }

  #log() {
    // Without a terminal every redraw would be its own line, so speak up only
    // once in a while — enough that a CI log shows movement, not a flood. The
    // last page always speaks, but only a total that exists can be reached:
    // before the first page there is no total, and 0 of 0 is not an ending.
    const finished = this.total > 0 && this.done >= this.total;
    if (!finished && this.done < this.reported + this.every) return;
    this.reported = this.done;
    const count = this.total > 0 ? `${this.done}/${this.total}` : String(this.done);
    this.stream.write(`${this.label} ${count}\n`);
  }

  #clear() {
    if (!this.drawn) return;
    if (this.stream.clearLine) {
      this.stream.cursorTo(0);
      this.stream.clearLine(0);
    } else {
      this.stream.write('\r');
    }
  }

  /**
   * Take the meter down and leave one line behind saying what happened. The
   * transient bar is erased: it described the wait, not the result.
   */
  finish(summary) {
    if (this.tty) {
      this.#clear();
      this.drawn = false;
    }
    if (summary) this.stream.write(`${summary}\n`);
  }
}
