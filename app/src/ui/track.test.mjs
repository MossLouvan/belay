// Unit tests for the track rule's state logic (docs/DESIGN.md §11.1, as
// amended by docs/REVAMP-SPEC.md §5.3 / §3.5 — granite at rest, orange only
// under load).
//
//   cd app && node --test src/ui/track.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DISABLED_TRACK_OPACITY, trackInks } from './track.ts';

// A stand-in ink set: the values only need to be distinguishable, the real
// palette is resolved by TrackLabel from the theme.
const INKS = Object.freeze({
  restLabel: 'textDim',
  activeLabel: 'accent',
  restTrack: 'trackRest',
  activeTrack: 'accentGraphic',
  pressLabel: 'text',
});

test('at rest the label is quiet and the rope is slack granite — present, never transparent, never orange', () => {
  const inks = trackInks({}, INKS);
  assert.equal(inks.label, 'textDim');
  assert.equal(inks.track, 'trackRest');
  assert.equal(inks.opacity, 1);
});

test('active lights both the label and the track — orange means engaged', () => {
  const inks = trackInks({ active: true }, INKS);
  assert.equal(inks.label, 'accent');
  assert.equal(inks.track, 'accentGraphic');
  assert.equal(inks.opacity, 1);
});

test('press-in ignites the track and loads the label to full ink — the rope takes load (§3.5)', () => {
  const inks = trackInks({ pressed: true }, INKS);
  assert.equal(inks.label, 'text');
  assert.equal(inks.track, 'accentGraphic');
  assert.equal(inks.opacity, 1);
});

test('pressing an already-active key keeps its accent label; the track stays lit', () => {
  const inks = trackInks({ active: true, pressed: true }, INKS);
  assert.equal(inks.label, 'accent');
  assert.equal(inks.track, 'accentGraphic');
});

test('an ink set without pressLabel falls back to activeLabel under press', () => {
  const { pressLabel, ...bare } = INKS;
  const inks = trackInks({ pressed: true }, bare);
  assert.equal(inks.label, 'accent');
  assert.equal(inks.track, 'accentGraphic');
});

test('disabled dims the whole control instead of swapping inks — a dimmed control, not a caption', () => {
  const rest = trackInks({ disabled: true }, INKS);
  assert.equal(rest.label, 'textDim');
  assert.equal(rest.track, 'trackRest');
  assert.equal(rest.opacity, DISABLED_TRACK_OPACITY);

  // Disabling an active control keeps its active marks, only dimmed: state
  // and availability are orthogonal.
  const active = trackInks({ active: true, disabled: true }, INKS);
  assert.equal(active.label, 'accent');
  assert.equal(active.track, 'accentGraphic');
  assert.equal(active.opacity, DISABLED_TRACK_OPACITY);
});

test('a disabled key cannot take load — pressed is ignored while disabled', () => {
  const inks = trackInks({ disabled: true, pressed: true }, INKS);
  assert.equal(inks.label, 'textDim');
  assert.equal(inks.track, 'trackRest');
  assert.equal(inks.opacity, DISABLED_TRACK_OPACITY);
});

test('overridden ink sets resolve the same way — the HUD dock is not a special case', () => {
  const hud = { restLabel: 'hudInk', activeLabel: 'hudAccent', restTrack: 'hudHairline', activeTrack: 'hudGraphic', pressLabel: 'hudText' };
  assert.deepEqual(trackInks({}, hud), { label: 'hudInk', track: 'hudHairline', opacity: 1 });
  assert.deepEqual(trackInks({ active: true }, hud), { label: 'hudAccent', track: 'hudGraphic', opacity: 1 });
  assert.deepEqual(trackInks({ pressed: true }, hud), { label: 'hudText', track: 'hudGraphic', opacity: 1 });
});
