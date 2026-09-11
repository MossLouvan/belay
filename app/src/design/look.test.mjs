import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookFor, looks } from './look.ts';

test('lookFor: light is Current, dark is Fieldwork', () => {
  assert.equal(lookFor('light').name, 'current');
  assert.equal(lookFor('dark').name, 'fieldwork');
});

test('lookFor: returns the shared frozen table entry, never a fresh object', () => {
  assert.equal(lookFor('light'), looks.current);
  assert.equal(lookFor('dark'), looks.fieldwork);
  assert.equal(Object.isFrozen(looks.current), true);
  assert.equal(Object.isFrozen(looks.fieldwork), true);
});

test('looks: the two appearances differ on every shape switch that has one', () => {
  const { current, fieldwork } = looks;
  assert.notEqual(current.devicesTitle, fieldwork.devicesTitle);
  assert.equal(typeof current.devicesSubtitle, 'string');
  assert.equal(fieldwork.devicesSubtitle, null);
  assert.equal(current.connectInline, false);
  assert.equal(fieldwork.connectInline, true);
  assert.equal(current.screenTitleLarge, true);
  assert.equal(fieldwork.screenTitleLarge, false);
  assert.equal(current.backLabel, 'Computers');
  assert.equal(fieldwork.backLabel, null);
  assert.equal(current.segmentSoft, false);
  assert.equal(fieldwork.segmentSoft, true);
  assert.equal(current.headerAction, 'add');
  assert.equal(fieldwork.headerAction, 'menu');
  assert.equal(current.deviceThumbWide, false);
  assert.equal(fieldwork.deviceThumbWide, true);
  assert.equal(current.cardBorder, true);
  assert.equal(fieldwork.cardBorder, false);
  assert.equal(current.titleGap > fieldwork.titleGap, true);
});

test('looks: the trackpad has exactly one treatment per appearance', () => {
  // Current explains the surface in words; Fieldwork makes it felt with a
  // texture. A pad with both, or neither, is a regression.
  for (const look of Object.values(looks)) {
    assert.equal(look.padHint !== look.padTexture, true, `${look.name} pad treatment`);
  }
});

test('looks: radii are on the scale and controls are tighter than cards', () => {
  for (const look of Object.values(looks)) {
    assert.equal(look.controlRadius < look.cardRadius, true, `${look.name} radii`);
    assert.equal(look.cardRadius % 4, 0, `${look.name} card radius on the 4pt scale`);
    assert.equal(look.titleGap % 4, 0, `${look.name} title gap on the 4pt scale`);
    assert.equal(look.titleGap >= 0, true, `${look.name} title gap is not negative`);
  }
});
