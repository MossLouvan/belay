import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_MODE, LOOK_CHOICES, normalizeMode, resolveLook } from '../src/look.js';

test('the picker offers the phone\'s four looks, in its order', () => {
  assert.deepEqual(LOOK_CHOICES.map((c) => c.label), ['Harbour', 'Night', 'Current', 'Fieldwork']);
});

test('system is Harbour by day and Night when the OS is dark', () => {
  assert.equal(DEFAULT_MODE, 'system');
  assert.deepEqual(resolveLook('system', false), { mode: 'system', name: 'harbour', look: 'harbour', scheme: 'light' });
  assert.deepEqual(resolveLook('system', true), { mode: 'system', name: 'night', look: 'harbour', scheme: 'dark' });
});

test('explicit looks ignore the OS', () => {
  for (const dark of [false, true]) {
    assert.deepEqual(resolveLook('harbour', dark), { mode: 'harbour', name: 'harbour', look: 'harbour', scheme: 'light' });
    assert.deepEqual(resolveLook('night', dark), { mode: 'night', name: 'night', look: 'harbour', scheme: 'dark' });
    assert.deepEqual(resolveLook('current', dark), { mode: 'current', name: 'current', look: 'current', scheme: 'light' });
    assert.deepEqual(resolveLook('fieldwork', dark), { mode: 'fieldwork', name: 'fieldwork', look: 'fieldwork', scheme: 'dark' });
  }
});

test('anything unknown falls back to system', () => {
  for (const junk of [undefined, null, '', 'dark', 'light', '__proto__', 42]) assert.equal(normalizeMode(junk), 'system');
  assert.equal(resolveLook('ledger', true).name, 'night');
});
