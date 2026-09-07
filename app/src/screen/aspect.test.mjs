// Unit tests for the remote aspect ratio.
//
//   cd app && node --test src/screen/host-facts.test.mjs
//
// Why this exists: H.264 (BWP) never fills the JPEG stats counters, so the
// stage fell back to the primary monitor's shape even when the offer said
// the picture was a different size (a secondary monitor, a scaled capture).
// A wrong aspect letterboxes the picture AND skews every touch coordinate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aspectOf } from './aspect.ts';

const noStats = { fps: 0, width: 0, height: 0, sourceWidth: 0, sourceHeight: 0 };
const info = { primary: { W: 2560, H: 1440 } };

test('the BWP offer size wins over every other source', () => {
  const jpeg = { ...noStats, sourceWidth: 1920, sourceHeight: 1080 };
  assert.equal(aspectOf(jpeg, info, { width: 1080, height: 1920 }), 1080 / 1920);
});

test('an empty BWP size is ignored', () => {
  assert.equal(aspectOf(noStats, info, { width: 0, height: 0 }), 2560 / 1440);
  assert.equal(aspectOf(noStats, info), 2560 / 1440);
});

test('JPEG source size still beats the primary monitor', () => {
  const jpeg = { ...noStats, sourceWidth: 1920, sourceHeight: 1200 };
  assert.equal(aspectOf(jpeg, info), 1920 / 1200);
});

test('nothing known falls back to 16:9', () => {
  assert.equal(aspectOf(noStats, null), 16 / 9);
});
