import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceFor, looks } from './look.ts';

test('appearanceFor: Harbour is the default and has a day and a night', () => {
  assert.deepEqual(appearanceFor('harbour', 'dark'), { look: 'harbour', scheme: 'light' });
  assert.deepEqual(appearanceFor('harbour-night', 'light'), { look: 'harbour', scheme: 'dark' });
  assert.deepEqual(appearanceFor('nonsense', 'dark'), { look: 'harbour', scheme: 'light' });
});

test('appearanceFor: legacy modes keep their meaning', () => {
  assert.deepEqual(appearanceFor('current', 'dark'), { look: 'current', scheme: 'light' });
  assert.deepEqual(appearanceFor('light', 'dark'), { look: 'current', scheme: 'light' });
  assert.deepEqual(appearanceFor('fieldwork', 'light'), { look: 'fieldwork', scheme: 'dark' });
  assert.deepEqual(appearanceFor('dark', 'light'), { look: 'fieldwork', scheme: 'dark' });
  assert.deepEqual(appearanceFor('system', 'light'), { look: 'current', scheme: 'light' });
  assert.deepEqual(appearanceFor('system', 'dark'), { look: 'fieldwork', scheme: 'dark' });
});

test('looks: every entry is frozen', () => {
  for (const look of Object.values(looks)) assert.equal(Object.isFrozen(look), true, look.name);
});

test('looks: Harbour keeps Current\'s layout and changes only the dressing', () => {
  const { harbour, current } = looks;
  const dressing = new Set(['name', 'cardRadius', 'controlRadius', 'segmentSoft']);
  for (const key of Object.keys(current)) {
    if (!dressing.has(key)) assert.equal(harbour[key], current[key], key);
  }
  assert.equal(harbour.controlRadius, 999, 'pill controls');
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
    // Harbour's controls are pills (999), the site's cloud and setup pills.
    assert.equal(look.controlRadius < look.cardRadius || look.controlRadius === 999, true, `${look.name} radii`);
    assert.equal(look.cardRadius % 4, 0, `${look.name} card radius on the 4pt scale`);
    assert.equal(look.titleGap % 4, 0, `${look.name} title gap on the 4pt scale`);
    assert.equal(look.titleGap >= 0, true, `${look.name} title gap is not negative`);
  }
});
