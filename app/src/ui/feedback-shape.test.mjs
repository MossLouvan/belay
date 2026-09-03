// Unit tests for the feedback primitives' pure rules (REVAMP-SPEC §3.5, §5.2,
// §5.8).
//
//   cd app && node --test src/ui/feedback-shape.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dotFillTarget, dotFillTransition, stripHorizontalInsets } from './feedback-shape.ts';

const MOTION = Object.freeze({ fast: 120, instant: 0 });

// --- ring/fill (§5.2) -------------------------------------------------------

test('a ring is hollow, a steady dot is filled', () => {
  assert.equal(dotFillTarget(true), 0);
  assert.equal(dotFillTarget(false), 1);
});

test('ring→fill is the one animated moment: 120ms fade to filled', () => {
  const t = dotFillTransition(true, false, MOTION);
  assert.deepEqual(t, { toValue: 1, duration: 120 });
});

test('fill→ring snaps — dropping the link earns no motion', () => {
  const t = dotFillTransition(false, true, MOTION);
  assert.deepEqual(t, { toValue: 0, duration: 0 });
});

test('same-shape re-renders are instant (no re-celebration on re-render)', () => {
  assert.deepEqual(dotFillTransition(false, false, MOTION), { toValue: 1, duration: 0 });
  assert.deepEqual(dotFillTransition(true, true, MOTION), { toValue: 0, duration: 0 });
});

test('reduced motion makes even the fill instant', () => {
  const t = dotFillTransition(true, false, MOTION, true);
  assert.deepEqual(t, { toValue: 1, duration: 0 });
});

// --- Banner full-bleed (§5.8) ----------------------------------------------

test('horizontal insets are stripped, vertical ones survive', () => {
  const out = stripHorizontalInsets({ marginHorizontal: 20, marginBottom: 8 });
  assert.deepEqual(out, { marginBottom: 8 });
});

test('each directional horizontal margin dies individually', () => {
  const out = stripHorizontalInsets({
    marginLeft: 1, marginRight: 2, marginStart: 3, marginEnd: 4, marginVertical: 6,
  });
  assert.deepEqual(out, { marginVertical: 6 });
});

test('the margin shorthand keeps only its vertical half', () => {
  assert.deepEqual(stripHorizontalInsets({ margin: 12 }), { marginVertical: 12 });
  // …but never clobbers an explicit vertical margin.
  assert.deepEqual(
    stripHorizontalInsets({ margin: 12, marginVertical: 4 }),
    { marginVertical: 4 }
  );
});

test('nested arrays and falsy holes flatten like RN styles', () => {
  const out = stripHorizontalInsets([
    { marginHorizontal: 20 },
    false,
    [undefined, { marginTop: 4 }, [{ opacity: 0.5 }]],
    null,
  ]);
  assert.deepEqual(out, { marginTop: 4, opacity: 0.5 });
});

test('empty and missing styles come back as a fresh empty object', () => {
  assert.deepEqual(stripHorizontalInsets(undefined), {});
  assert.deepEqual(stripHorizontalInsets(null), {});
});

test('input is never mutated', () => {
  const input = Object.freeze({ marginHorizontal: 20, marginTop: 2 });
  const out = stripHorizontalInsets(input);
  assert.deepEqual(out, { marginTop: 2 });
  assert.deepEqual(input, { marginHorizontal: 20, marginTop: 2 });
});
