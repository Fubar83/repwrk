import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Progress, estimateRemaining, formatDuration, renderBar } from '../src/progress.js';

/**
 * A stand-in for stderr that records what was written, terminal or not.
 * Cursor movement is recorded apart from the text, so `writes` stays a
 * faithful record of what a reader would actually have seen.
 */
function fakeStream({ tty = true } = {}) {
  const writes = [];
  const ops = [];
  const stream = {
    isTTY: tty,
    writes,
    ops,
    write: (text) => writes.push(text),
    get text() {
      return writes.join('');
    },
  };
  if (tty) {
    stream.cursorTo = () => ops.push('cursor');
    stream.clearLine = () => ops.push('clear');
  }
  return stream;
}

/** A clock that only moves when told to, so timings are not wall-clock flaky. */
function fakeClock() {
  let at = 0;
  const now = () => at;
  now.advance = (ms) => {
    at += ms;
  };
  return now;
}

/** What a reader sees, with any colour escapes taken off. */
const strip = (text) => text.replace(/\x1B\[\d+m/g, '');

const lines = (stream) => stream.writes;

test('the bar fills in proportion, and an unknown total fills nothing', () => {
  assert.equal(renderBar(0, 10, { width: 4, full: '#', empty: '-' }), '----');
  assert.equal(renderBar(5, 10, { width: 4, full: '#', empty: '-' }), '##--');
  assert.equal(renderBar(10, 10, { width: 4, full: '#', empty: '-' }), '####');
  assert.equal(renderBar(3, 0, { width: 4, full: '#', empty: '-' }), '----');
});

test('a bar never overflows, whatever it is told', () => {
  assert.equal(renderBar(99, 10, { width: 4, full: '#', empty: '-' }), '####');
  assert.equal(renderBar(-5, 10, { width: 4, full: '#', empty: '-' }), '----');
});

test('durations read as seconds under a minute and m:ss above', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(900), '1s');
  assert.equal(formatDuration(59_400), '59s');
  assert.equal(formatDuration(65_000), '1m05s');
  assert.equal(formatDuration(3_600_000), '60m00s');
});

// A guess drawn from too little evidence is worse than no guess, so the
// estimate stays quiet until it has something to go on.
test('no estimate is offered before there is anything to estimate from', () => {
  assert.equal(estimateRemaining(0, 100, 1000), null, 'nothing fetched yet');
  assert.equal(estimateRemaining(100, 100, 1000), null, 'already finished');
  assert.equal(estimateRemaining(50, 100, 0), null, 'no time has passed');
  assert.equal(estimateRemaining(99, 100, 1000), null, 'under a second left is not worth saying');
  assert.equal(estimateRemaining(100, 1000, 10_000), 90_000);
});

test('a terminal is redrawn in place, never scrolled', () => {
  const stream = fakeStream();
  const progress = new Progress('repwrk: listing acme', { stream, now: fakeClock() });

  progress.update(100, 1000);
  progress.update(200, 1000);

  assert.equal(lines(stream).length, 2);
  assert.ok(lines(stream).every((line) => !line.includes('\n')), 'no line is ever finished');
  assert.ok(stream.ops.includes('clear'), 'the previous line is erased first');
  assert.match(lines(stream)[1], /repwrk: listing acme .* 200\/1000/);
});

test('the meter says how much longer once it can', () => {
  const now = fakeClock();
  const stream = fakeStream();
  const progress = new Progress('listing', { stream, now });

  now.advance(10_000);
  progress.update(100, 1000);

  assert.match(strip(lines(stream).at(-1)), /100\/1000, 1m30s left/);
});

test('finishing erases the bar and leaves the summary behind', () => {
  const stream = fakeStream();
  const progress = new Progress('listing', { stream, now: fakeClock() });

  progress.update(500, 1000);
  progress.finish('repwrk: listed 1000 repositories in 42s');

  assert.equal(stream.text.endsWith('repwrk: listed 1000 repositories in 42s\n'), true);
  assert.equal(lines(stream).at(-1).includes('█'), false, 'no bar survives the teardown');
});

test('finishing with nothing to say leaves nothing behind', () => {
  const stream = fakeStream();
  const progress = new Progress('listing', { stream, now: fakeClock() });
  progress.update(1, 10);
  progress.finish();

  assert.equal(lines(stream).length, 1, 'only the bar was ever written');
});

// Redrawing without a terminal would put every frame on its own line, which in
// a CI log is thousands of lines saying almost nothing.
test('without a terminal, progress is occasional whole lines', () => {
  const stream = fakeStream({ tty: false });
  const progress = new Progress('repwrk: listing acme', { stream, now: fakeClock(), every: 1000 });

  // Before the first page there is no total, and "0 of 0" is not an ending to
  // announce — it used to read as one, and printed a bare "0".
  progress.update(0, 0);
  assert.deepEqual(lines(stream), [], 'nothing is said before anything is known');

  for (let fetched = 100; fetched <= 900; fetched += 100) progress.update(fetched, 5000);
  assert.equal(lines(stream).length, 0, 'nothing worth saying yet');

  progress.update(1000, 5000);
  assert.deepEqual(lines(stream), ['repwrk: listing acme 1000/5000\n']);

  progress.update(5000, 5000);
  assert.equal(lines(stream).at(-1), 'repwrk: listing acme 5000/5000\n', 'the end is always said');
});

test('an untouched meter can still be finished', () => {
  const stream = fakeStream();
  const progress = new Progress('listing', { stream, now: fakeClock() });
  assert.doesNotThrow(() => progress.finish());
  assert.equal(stream.text, '');
});

// The bar is only ever drawn on a terminal, so it may carry colour. The plain
// lines a non-terminal gets must stay exactly as they always were.
test('a drawn bar may be coloured, and a logged line never is', () => {
  const drawn = fakeStream();
  new Progress('listing', { stream: drawn, now: fakeClock() }).update(5, 10);
  assert.match(strip(lines(drawn)[0]), /listing .* 5\/10/);

  const logged = fakeStream({ tty: false });
  new Progress('listing', { stream: logged, now: fakeClock(), every: 1 }).update(5, 10);
  assert.deepEqual(lines(logged), ['listing 5/10\n'], 'no escapes reach a pipe');
});
