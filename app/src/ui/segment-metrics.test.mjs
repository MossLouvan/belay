// Unit tests for the shared segment-control metrics.
//
//   cd app && node --test src/ui/segment-metrics.test.mjs
//
// Pure numbers, no framework — same shape as the other suites here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEGMENT_HEIGHT,
  SEGMENT_LABEL_SIZE,
  SEGMENT_TRACK_INSET,
  segmentChipRadius,
  segmentHitSlop,
  segmentTrackRadius,
} from './segment-metrics.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test('the track inset is the 3pt optical seam both strips drew by hand', () => {
  assert.equal(SEGMENT_TRACK_INSET, 3);
});

test('a segment stands 34pt, under the 44pt minimum touch target', () => {
  assert.equal(SEGMENT_HEIGHT, 34);
  assert.ok(SEGMENT_HEIGHT < 44, 'the hitSlop top-up only makes sense below the minimum');
});

test('the label sits one step under type.button', () => {
  assert.equal(SEGMENT_LABEL_SIZE, 14);
});

// ---------------------------------------------------------------------------
// radii
// ---------------------------------------------------------------------------

test('the track rounds four points past the control radius', () => {
  assert.equal(segmentTrackRadius(10), 14); // Current
  assert.equal(segmentTrackRadius(8), 12);  // Fieldwork
});

test('the chip rounds one point past the control radius', () => {
  assert.equal(segmentChipRadius(10), 11);
  assert.equal(segmentChipRadius(8), 9);
});

test('the chip is always tighter than the track that holds it', () => {
  for (const r of [0, 4, 8, 10, 16, 20]) {
    assert.ok(segmentChipRadius(r) < segmentTrackRadius(r), `chip >= track at ${r}`);
  }
});

test('a zero control radius still yields the nested-rectangle relationship', () => {
  assert.equal(segmentTrackRadius(0), 4);
  assert.equal(segmentChipRadius(0), 1);
});

test('radii reject values that are not finite non-negative numbers', () => {
  assert.throws(() => segmentTrackRadius(-1), /finite radius/);
  assert.throws(() => segmentChipRadius(Number.NaN), /finite radius/);
  assert.throws(() => segmentTrackRadius(Number.POSITIVE_INFINITY), /finite radius/);
});

// ---------------------------------------------------------------------------
// hit slop
// ---------------------------------------------------------------------------

test('slop splits the 44pt shortfall evenly above and below', () => {
  assert.deepEqual({ ...segmentHitSlop(44) }, { top: 5, bottom: 5 });
});

test('slop tops a segment up to at least the minimum touch target', () => {
  const slop = segmentHitSlop(44);
  assert.ok(SEGMENT_HEIGHT + slop.top + slop.bottom >= 44);
});

test('an odd shortfall rounds rather than truncating', () => {
  assert.deepEqual({ ...segmentHitSlop(44, 33) }, { top: 6, bottom: 6 });
});

test('a segment already at or above the minimum takes no slop', () => {
  assert.deepEqual({ ...segmentHitSlop(44, 44) }, { top: 0, bottom: 0 });
  assert.deepEqual({ ...segmentHitSlop(44, 60) }, { top: 0, bottom: 0 });
});

test('the returned slop is frozen, so a caller cannot mutate the shared shape', () => {
  const slop = segmentHitSlop(44);
  assert.ok(Object.isFrozen(slop));
});

test('slop rejects non-finite inputs', () => {
  assert.throws(() => segmentHitSlop(Number.NaN), /finite numbers/);
  assert.throws(() => segmentHitSlop(44, Number.NaN), /finite numbers/);
});
