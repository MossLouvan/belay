// Taps are never delayed: the first tap clicks at once (count 1) and a second
// tap inside the double-tap window and slop clicks again with count 2, which
// the host posts as clickState 2 — a real double-click.
//
//   cd app && node --test src/screen/tap-plan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GESTURE } from './model.ts';
import { planTap } from './tap-plan.ts';

const P = { x: 0.5, y: 0.5 };

test('a lone tap clicks immediately with count 1 and remembers itself', () => {
  const plan = planTap(null, P, 1000);
  assert.equal(plan.count, 1);
  assert.deepEqual(plan.point, P);
  assert.deepEqual(plan.next, { x: 0.5, y: 0.5, at: 1000 });
});

test('a second tap inside the window and slop is click #2 at the first point', () => {
  const first = planTap(null, P, 1000);
  const second = planTap(first.next, { x: 0.52, y: 0.49 }, 1000 + GESTURE.doubleTapMs - 1);
  assert.equal(second.count, 2);
  assert.deepEqual(second.point, P);
  assert.equal(second.next, null, 'a third tap starts a fresh sequence');
});

test('a tap after the window, or too far away, is a fresh single click', () => {
  const first = planTap(null, P, 1000);
  const late = planTap(first.next, P, 1000 + GESTURE.doubleTapMs + 1);
  assert.equal(late.count, 1);
  assert.deepEqual(late.next, { x: 0.5, y: 0.5, at: 1000 + GESTURE.doubleTapMs + 1 });
  const far = planTap(first.next, { x: 0.5 + GESTURE.doubleTapSlop + 0.01, y: 0.5 }, 1100);
  assert.equal(far.count, 1);
});
