// Unit tests for scroll mode's pure maths: one-finger classification, the
// gain-scaled notch batching, throttling, and the flick's stopping rule.
//
//   cd app && node --test src/screen/scroll-mode.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GESTURE } from './model.ts';
import {
  batchScroll,
  classifyOneFinger,
  decayStep,
  flickSpent,
  flickStep,
  pxPerNotch as pxPerNotchOf,
  scrollDue,
} from './scroll-mode.ts';

// The suite runs against the REAL tunables, exactly as the viewport passes
// them, so a change to GESTURE that inverts or zeroes the scroll fails here.
const pxPerNotch = pxPerNotchOf(GESTURE);

// --- classification ---------------------------------------------------------

test('under the tap slop every mode stays pending — a tap is a click everywhere', () => {
  const under = GESTURE.tapSlopPx - 1;
  for (const mode of ['touch', 'trackpad', 'scroll']) {
    assert.equal(classifyOneFinger('pending', under, 0, mode, 1, GESTURE), 'pending', mode);
    assert.equal(classifyOneFinger('pending', 0, under, mode, 3, GESTURE), 'pending', mode);
  }
});

test('past the slop, each mode gets its own intent', () => {
  const past = GESTURE.tapSlopPx + 1;
  assert.equal(classifyOneFinger('pending', 0, past, 'scroll', 1, GESTURE), 'wheel');
  assert.equal(classifyOneFinger('pending', 0, past, 'scroll', 4, GESTURE), 'wheel', 'scroll wins even when zoomed');
  assert.equal(classifyOneFinger('pending', 0, past, 'trackpad', 1, GESTURE), 'cursor');
  assert.equal(classifyOneFinger('pending', 0, past, 'touch', 1, GESTURE), 'hostDrag');
  assert.equal(classifyOneFinger('pending', 0, past, 'touch', 2, GESTURE), 'pan');
});

test('a classified gesture keeps its intent when the mode changes mid-drag', () => {
  assert.equal(classifyOneFinger('wheel', 500, 500, 'touch', 1, GESTURE), 'wheel');
  assert.equal(classifyOneFinger('consumed', 500, 500, 'scroll', 1, GESTURE), 'consumed');
});

// --- batching ---------------------------------------------------------------

test('direction: positive finger delta stays positive — content follows the finger', () => {
  const down = batchScroll(pxPerNotch * 2, 0, GESTURE);
  assert.ok(down.dy > 0, 'drag down sends positive dy, like the two-finger gesture');
  const up = batchScroll(-pxPerNotch * 2, 0, GESTURE);
  assert.ok(up.dy < 0);
  const right = batchScroll(0, pxPerNotch * 2, GESTURE);
  assert.ok(right.dx > 0);
});

test('the gain buys notches with less finger travel than the raw notch size', () => {
  // Exactly GESTURE.pxPerScrollNotch of travel must yield MORE than one notch
  // while scrollGain > 1 — the tunable inverting or zeroing would fail here.
  assert.ok(GESTURE.scrollGain > 1, 'the owner asked for higher sensitivity');
  const batch = batchScroll(GESTURE.pxPerScrollNotch, 0, GESTURE);
  assert.ok(batch.dy >= Math.floor(GESTURE.scrollGain), `got ${batch.dy}`);
});

test('sub-notch travel sends nothing but owes the remainder', () => {
  const px = pxPerNotch * 0.6;
  const batch = batchScroll(px, -px, GESTURE);
  assert.equal(batch.dy, 0);
  assert.equal(batch.dx, 0);
  assert.ok(Math.abs(batch.restY - px) < 1e-9, 'remainder carried, not dropped');
  assert.ok(Math.abs(batch.restX + px) < 1e-9);
});

test('remainders add up: two sub-notch moves equal one whole notch', () => {
  const px = pxPerNotch * 0.6;
  const first = batchScroll(px, 0, GESTURE);
  const second = batchScroll(first.restY + px, 0, GESTURE);
  assert.equal(second.dy, 1);
});

test('a send is clamped to maxNotchesPerSend and the excess is discarded', () => {
  const wild = batchScroll(pxPerNotch * 1000, 0, GESTURE);
  assert.equal(wild.dy, GESTURE.maxNotchesPerSend);
  assert.equal(wild.restY, 0, 'no banked scroll debt after a wild flick');
  const wildUp = batchScroll(-pxPerNotch * 1000, 0, GESTURE);
  assert.equal(wildUp.dy, -GESTURE.maxNotchesPerSend);
});

test('a steady drag never loses or duplicates pixels across throttled sends', () => {
  // Simulate the wheel branch's bookkeeping: cumulative dy grows, the anchor
  // advances by exactly what each batch consumed.
  const perMove = 13;
  let totalDy = 0;
  let anchor = 0;
  let notches = 0;
  for (let i = 0; i < 100; i += 1) {
    totalDy += perMove;
    const batch = batchScroll(totalDy - anchor, 0, GESTURE);
    if (batch.dy !== 0) {
      anchor = totalDy - batch.restY;
      notches += batch.dy;
    }
  }
  assert.equal(notches, Math.trunc((100 * perMove) / pxPerNotch));
});

// --- throttling -------------------------------------------------------------

test('scrollDue enforces scrollThrottleMs exactly', () => {
  assert.equal(scrollDue(1000, 1000, GESTURE), false, 'same instant');
  assert.equal(scrollDue(1000 + GESTURE.scrollThrottleMs - 1, 1000, GESTURE), false);
  assert.equal(scrollDue(1000 + GESTURE.scrollThrottleMs, 1000, GESTURE), true, 'boundary sends');
});

// --- momentum ---------------------------------------------------------------

test('a flick decays to spent in finite frames and travels a finite distance', () => {
  let px = flickStep(2.5, GESTURE); // a hard flick: 2.5 px/ms
  let acc = 0;
  let frames = 0;
  while (!flickSpent(px, 0, 0, acc % pxPerNotch, GESTURE) && frames < 10000) {
    px = decayStep(px, GESTURE);
    acc += px;
    frames += 1;
  }
  assert.ok(frames > 5, 'a flick coasts for more than a moment');
  assert.ok(frames < 600, `spent within ten seconds of frames, took ${frames}`);
  // Geometric series bound: v*frameMs * friction/(1-friction).
  const bound = (2.5 * GESTURE.frameMs * GESTURE.friction) / (1 - GESTURE.friction);
  assert.ok(acc <= bound + 1e-9);
});

test('flickSpent waits for BOTH a dead velocity and an unpayable remainder', () => {
  const dead = GESTURE.minMomentumPx / 2;
  assert.equal(flickSpent(dead, dead, 0, pxPerNotch * 2, GESTURE), false, 'a notch is still owed');
  assert.equal(flickSpent(GESTURE.minMomentumPx * 2, 0, 0, 0, GESTURE), false, 'still moving');
  assert.equal(flickSpent(dead, dead, 0, pxPerNotch * 0.5, GESTURE), true);
});
