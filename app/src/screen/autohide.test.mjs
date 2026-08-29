// Unit tests for the overlay auto-hide timing decisions.
//
//   cd app && node --test src/screen/autohide.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUTO_HIDE_MS, ZOOM_DIM_MS, DIMMED_OPACITY, stillVisible, hideDelayRemaining } from './autohide.ts';

test('the dock outlives a touch by exactly the advertised window', () => {
  const poked = 10_000;
  assert.equal(stillVisible(poked, poked, AUTO_HIDE_MS), true, 'visible the instant it is poked');
  assert.equal(stillVisible(poked + AUTO_HIDE_MS - 1, poked, AUTO_HIDE_MS), true);
  assert.equal(stillVisible(poked + AUTO_HIDE_MS, poked, AUTO_HIDE_MS), false, 'gone at the deadline');
});

test('a re-poke restarts the countdown from the new poke', () => {
  const first = 1000;
  const second = first + 3000;
  assert.equal(stillVisible(second + AUTO_HIDE_MS - 1, second, AUTO_HIDE_MS), true);
  assert.equal(stillVisible(second + AUTO_HIDE_MS - 1, first, AUTO_HIDE_MS), false, 'the old poke alone would not cover it');
});

test('hideDelayRemaining counts down and floors at zero', () => {
  assert.equal(hideDelayRemaining(1000, 1000, AUTO_HIDE_MS), AUTO_HIDE_MS);
  assert.equal(hideDelayRemaining(2500, 1000, AUTO_HIDE_MS), AUTO_HIDE_MS - 1500);
  assert.equal(hideDelayRemaining(999_999, 1000, AUTO_HIDE_MS), 0, 'overdue hides now, not with a negative delay');
});

test('a poke from the future (clock skew) behaves like "just now"', () => {
  assert.equal(hideDelayRemaining(1000, 5000, AUTO_HIDE_MS), AUTO_HIDE_MS);
  assert.equal(stillVisible(1000, 5000, AUTO_HIDE_MS), true);
});

test('the tuning constants keep their intent: dim before hide, and truly dim', () => {
  assert.ok(ZOOM_DIM_MS < AUTO_HIDE_MS, 'the pill dims sooner than the dock hides');
  assert.ok(DIMMED_OPACITY > 0 && DIMMED_OPACITY < 0.5, 'dimmed overlays stay findable but recede');
});
