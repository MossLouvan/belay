// Unit tests for the pointer-mode roster the dock's ModeSwitch renders.
//
//   cd app && node --test src/screen/dock-modes.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POINTER_MODE_OPTIONS, pointerModeOption } from './dock-modes.ts';

test('all three pointer modes are present, the default first', () => {
  assert.deepEqual(
    POINTER_MODE_OPTIONS.map((option) => option.id),
    ['touch', 'trackpad', 'scroll']
  );
});

test('every option is fully worded — no unlabelled or unspoken segment', () => {
  for (const option of POINTER_MODE_OPTIONS) {
    assert.ok(option.label.length > 0, `${option.id} label`);
    assert.ok(option.accessibilityLabel.length > 0, `${option.id} a11y label`);
    assert.ok(option.hint.length > 0, `${option.id} hint`);
  }
});

test('labels are unique — three segments must never read the same', () => {
  const labels = POINTER_MODE_OPTIONS.map((option) => option.label);
  assert.equal(new Set(labels).size, labels.length);
});

test('pointerModeOption resolves each mode to its own row', () => {
  for (const option of POINTER_MODE_OPTIONS) {
    assert.equal(pointerModeOption(option.id), option);
  }
});

test('pointerModeOption never returns undefined — an unknown value falls back', () => {
  assert.equal(pointerModeOption('nonsense'), POINTER_MODE_OPTIONS[0]);
});

test('the roster is frozen — nothing downstream can mutate the options', () => {
  assert.ok(Object.isFrozen(POINTER_MODE_OPTIONS));
  for (const option of POINTER_MODE_OPTIONS) assert.ok(Object.isFrozen(option));
});
