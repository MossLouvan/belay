// Unit tests for the track rule's state logic (docs/DESIGN.md §11.1).
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
  restTrack: 'accentDim',
  activeTrack: 'accentGraphic',
});

test('at rest the label is quiet but the track is present — never transparent', () => {
  const inks = trackInks({}, INKS);
  assert.equal(inks.label, 'textDim');
  assert.equal(inks.track, 'accentDim');
  assert.equal(inks.opacity, 1);
});

test('active lights both the label and the track', () => {
  const inks = trackInks({ active: true }, INKS);
  assert.equal(inks.label, 'accent');
  assert.equal(inks.track, 'accentGraphic');
  assert.equal(inks.opacity, 1);
});

test('disabled dims the whole control instead of swapping inks — a dimmed control, not a caption', () => {
  const rest = trackInks({ disabled: true }, INKS);
  assert.equal(rest.label, 'textDim');
  assert.equal(rest.track, 'accentDim');
  assert.equal(rest.opacity, DISABLED_TRACK_OPACITY);

  // Disabling an active control keeps its active marks, only dimmed: state
  // and availability are orthogonal.
  const active = trackInks({ active: true, disabled: true }, INKS);
  assert.equal(active.label, 'accent');
  assert.equal(active.track, 'accentGraphic');
  assert.equal(active.opacity, DISABLED_TRACK_OPACITY);
});

test('overridden ink sets resolve the same way — the HUD dock is not a special case', () => {
  const hud = { restLabel: 'hudInk', activeLabel: 'hudAccent', restTrack: 'hudHairline', activeTrack: 'hudGraphic' };
  assert.deepEqual(trackInks({}, hud), { label: 'hudInk', track: 'hudHairline', opacity: 1 });
  assert.deepEqual(trackInks({ active: true }, hud), { label: 'hudAccent', track: 'hudGraphic', opacity: 1 });
});
