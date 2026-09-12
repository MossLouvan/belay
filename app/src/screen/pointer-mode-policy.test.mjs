// Unit tests for the per-orientation pointer-mode rule.
//
//   cd app && node --test src/screen/pointer-mode-policy.test.mjs
//
// The founder's two requirements, verbatim, are the two halves of this suite:
// rotating to landscape must land on PAD, and a mode he actually chose must be
// remembered rather than fought.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LANDSCAPE_DEFAULT_MODE,
  NO_MODE_CHOICES,
  PORTRAIT_DEFAULT_MODE,
  defaultModeFor,
  rememberMode,
  resolveMode,
} from './pointer-mode-policy.ts';

test('the defaults: touch upright, pad sideways', () => {
  assert.equal(PORTRAIT_DEFAULT_MODE, 'touch');
  assert.equal(LANDSCAPE_DEFAULT_MODE, 'trackpad');
  assert.equal(defaultModeFor(false), 'touch');
  assert.equal(defaultModeFor(true), 'trackpad');
});

test('a fresh session: portrait is touch, rotating sideways lands on pad', () => {
  assert.equal(resolveMode(NO_MODE_CHOICES, false), 'touch');
  assert.equal(resolveMode(NO_MODE_CHOICES, true), 'trackpad');
});

test('choosing in portrait does not change what landscape defaults to', () => {
  // He fiddles with Scroll upright. Turning the phone is still pad.
  const chose = rememberMode(NO_MODE_CHOICES, false, 'scroll');
  assert.equal(resolveMode(chose, false), 'scroll');
  assert.equal(resolveMode(chose, true), 'trackpad');
});

test('HE ALREADY CHOSE TOUCH sideways: rotating back must not override him', () => {
  // Landscape, he deliberately taps Touch.
  const chose = rememberMode(NO_MODE_CHOICES, true, 'touch');
  assert.equal(resolveMode(chose, true), 'touch');

  // Rotate upright, then sideways again: still the touch HE picked, not the
  // landscape default reasserting itself.
  assert.equal(resolveMode(chose, false), 'touch', 'portrait default');
  assert.equal(resolveMode(chose, true), 'touch', 'his landscape choice survives the round trip');
});

test('the landscape default only applies until he says otherwise, then never again', () => {
  let choices = NO_MODE_CHOICES;
  assert.equal(resolveMode(choices, true), 'trackpad');
  choices = rememberMode(choices, true, 'touch');
  assert.equal(resolveMode(choices, true), 'touch');
  // Even picking pad back is a choice, and stays a choice.
  choices = rememberMode(choices, true, 'trackpad');
  assert.equal(choices.landscape, 'trackpad');
  assert.equal(resolveMode(choices, true), 'trackpad');
});

test('each orientation keeps its own mode across as many rotations as you like', () => {
  let choices = rememberMode(NO_MODE_CHOICES, false, 'touch');
  choices = rememberMode(choices, true, 'scroll');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(resolveMode(choices, false), 'touch');
    assert.equal(resolveMode(choices, true), 'scroll');
  }
});

test('rememberMode never mutates the record it was given', () => {
  const before = NO_MODE_CHOICES;
  const after = rememberMode(before, true, 'scroll');
  assert.equal(before.landscape, null, 'the original is untouched');
  assert.equal(after.landscape, 'scroll');
  assert.notEqual(after, before);
});

test('re-picking the mode already chosen returns the same record (no re-render)', () => {
  const chosen = rememberMode(NO_MODE_CHOICES, true, 'touch');
  assert.equal(rememberMode(chosen, true, 'touch'), chosen);
});

test('picking the default explicitly is still recorded as a choice', () => {
  // Landscape already resolves to trackpad; tapping Pad must WRITE it, so a
  // later change of the default could never silently move him.
  const chosen = rememberMode(NO_MODE_CHOICES, true, 'trackpad');
  assert.equal(chosen.landscape, 'trackpad');
  assert.notEqual(chosen, NO_MODE_CHOICES);
});
