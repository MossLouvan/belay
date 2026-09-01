// Unit tests for held-key auto-repeat: the delay before the first repeat, the
// steady rate after it, back-pressure on a slow link, and — the one that
// matters most — that releasing the key always stops it.
//
//   cd app && node --test src/screen/repeat.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRepeater, REPEAT } from './repeat.ts';
import { KEYS } from './model.ts';

/** Fake clock: one pending timer at a time, which is all the repeater uses. */
function fakeClock() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const handle = next++;
      pending.set(handle, { fn, ms });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    /** Runs the one pending timer, returning its scheduled delay. */
    fire() {
      const [handle, entry] = [...pending.entries()][0] ?? [];
      if (entry === undefined) return null;
      pending.delete(handle);
      entry.fn();
      return entry.ms;
    },
    get size() {
      return pending.size;
    },
  };
}

const counting = () => {
  const state = { calls: 0 };
  return [() => { state.calls += 1; }, state];
};

// --- the shape of a hold ----------------------------------------------------

test('the press itself fires immediately, before any repeat', () => {
  const clock = fakeClock();
  const [send, state] = counting();
  const repeater = createRepeater(send, clock);

  repeater.start();

  assert.equal(state.calls, 1);
  assert.equal(clock.size, 1, 'a repeat should be armed');
});

test('the first repeat waits out the delay, then they come at the interval', () => {
  const clock = fakeClock();
  const [send, state] = counting();
  const repeater = createRepeater(send, clock);

  repeater.start();
  assert.equal(clock.fire(), REPEAT.delayMs, 'first repeat waits the hold delay');
  assert.equal(state.calls, 2);

  assert.equal(clock.fire(), REPEAT.intervalMs);
  assert.equal(clock.fire(), REPEAT.intervalMs);
  assert.equal(state.calls, 4);
});

test('a tap released before the delay sends exactly one key', () => {
  const clock = fakeClock();
  const [send, state] = counting();
  const repeater = createRepeater(send, clock);

  repeater.start();
  repeater.stop();

  assert.equal(state.calls, 1);
  assert.equal(clock.size, 0, 'the armed repeat must be cancelled');
});

test('honours overridden timings', () => {
  const clock = fakeClock();
  const [send] = counting();
  const repeater = createRepeater(send, clock, { delayMs: 10, intervalMs: 2 });

  repeater.start();
  assert.equal(clock.fire(), 10);
  assert.equal(clock.fire(), 2);
});

// --- release, the part that must never leak ---------------------------------

test('stop is idempotent and safe before start', () => {
  const clock = fakeClock();
  const [send, state] = counting();
  const repeater = createRepeater(send, clock);

  repeater.stop();
  assert.equal(state.calls, 0);

  repeater.start();
  repeater.stop();
  repeater.stop();
  assert.equal(state.calls, 1);
  assert.equal(clock.size, 0);
});

test('start while already running does not stack a second loop', () => {
  const clock = fakeClock();
  const [send, state] = counting();
  const repeater = createRepeater(send, clock);

  repeater.start();
  repeater.start();

  assert.equal(state.calls, 1, 'the second start is a no-op');
  assert.equal(clock.size, 1);
});

test('a hold can be started again after release', () => {
  const clock = fakeClock();
  const [send, state] = counting();
  const repeater = createRepeater(send, clock);

  repeater.start();
  repeater.stop();
  repeater.start();
  clock.fire();

  assert.equal(state.calls, 3, 'press, press, one repeat');
  assert.equal(repeater.running, true);
});

test('reports whether a hold is in progress', () => {
  const clock = fakeClock();
  const [send] = counting();
  const repeater = createRepeater(send, clock);

  assert.equal(repeater.running, false);
  repeater.start();
  assert.equal(repeater.running, true);
  repeater.stop();
  assert.equal(repeater.running, false);
});

// --- back-pressure over a slow link -----------------------------------------

test('waits for a pending send to settle before queueing the next repeat', async () => {
  const clock = fakeClock();
  let resolve;
  let calls = 0;
  const repeater = createRepeater(() => {
    calls += 1;
    return calls === 2 ? new Promise((r) => { resolve = r; }) : undefined;
  }, clock);

  repeater.start();
  clock.fire();

  assert.equal(calls, 2);
  assert.equal(clock.size, 0, 'nothing is armed while the send is in flight');

  resolve();
  await Promise.resolve();
  assert.equal(clock.size, 1, 'the next repeat is armed once it lands');
});

test('a rejected send keeps the hold alive rather than stalling it', async () => {
  const clock = fakeClock();
  let calls = 0;
  const repeater = createRepeater(() => {
    calls += 1;
    return calls === 2 ? Promise.reject(new Error('offline')) : undefined;
  }, clock);

  repeater.start();
  clock.fire();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(clock.size, 1, 'a dropped key must not end the hold');
});

test('a send that lands after release does not resurrect the loop', async () => {
  const clock = fakeClock();
  let resolve;
  let calls = 0;
  const repeater = createRepeater(() => {
    calls += 1;
    return calls === 2 ? new Promise((r) => { resolve = r; }) : undefined;
  }, clock);

  repeater.start();
  clock.fire();
  repeater.stop();

  resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(clock.size, 0, 'a late send must never re-arm after release');
  assert.equal(calls, 2);
});

// --- what is actually marked repeatable -------------------------------------

test('Backspace repeats on hold', () => {
  const bksp = KEYS.find((key) => key.id === 'Bksp');
  assert.ok(bksp, 'Bksp KeySpec exists');
  assert.equal(bksp.repeatable, true);
});

test('keys with side effects are never marked repeatable', () => {
  const dangerous = ['Quit', 'Lock', 'Enter', 'Ctrl+W', 'Ctrl+S', 'Alt+Tab'];
  for (const id of dangerous) {
    const spec = KEYS.find((key) => key.id === id);
    if (!spec) continue;
    assert.notEqual(spec.repeatable, true, `${id} must not auto-repeat`);
  }
});
