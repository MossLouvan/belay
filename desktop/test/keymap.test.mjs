// Unit tests for keyboard translation.
//
// The two mistakes worth guarding: sending a shortcut as literal text (ctrl+c
// typing the letter c into the document instead of copying), and sending a
// shifted character as a key combination (shift+4 arriving as "4" because the
// host re-derived the character from a US layout).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { translateKey, modifiersOf } from '../src/keymap.js';

function press(key, mods = {}) {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

test('a printable character is typed as text', () => {
  assert.deepEqual(translateKey(press('a')), { kind: 'text', text: 'a' });
  assert.deepEqual(translateKey(press('$', { shiftKey: true })), { kind: 'text', text: '$' });
  assert.deepEqual(translateKey(press('é')), { kind: 'text', text: 'é' });
});

test('an emoji survives the length test', () => {
  // Two UTF-16 code units: a naive key.length === 1 test drops it.
  assert.deepEqual(translateKey(press('😀')), { kind: 'text', text: '😀' });
});

test('ctrl and meta combinations become key events, not text', () => {
  assert.deepEqual(translateKey(press('c', { ctrlKey: true })), { kind: 'key', key: 'c', mods: ['ctrl'] });
  assert.deepEqual(translateKey(press('v', { metaKey: true })), { kind: 'key', key: 'v', mods: ['meta'] });
});

test('a shortcut key name is lowercased with its modifiers kept', () => {
  const out = translateKey(press('A', { ctrlKey: true, shiftKey: true }));
  assert.deepEqual(out, { kind: 'key', key: 'a', mods: ['ctrl', 'shift'] });
});

test('named keys map to the host key table', () => {
  assert.deepEqual(translateKey(press('Enter')), { kind: 'key', key: 'enter', mods: [] });
  assert.deepEqual(translateKey(press('ArrowLeft')), { kind: 'key', key: 'left', mods: [] });
  assert.deepEqual(translateKey(press('F5')), { kind: 'key', key: 'f5', mods: [] });
  assert.deepEqual(translateKey(press('Tab', { altKey: true })), { kind: 'key', key: 'tab', mods: ['alt'] });
});

test('a modifier pressed on its own sends nothing', () => {
  for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
    assert.equal(translateKey(press(key, { shiftKey: true })), null);
  }
});

test('an unmapped named key is dropped rather than typed as its name', () => {
  // The host types an unknown key name as literal text, so forwarding this
  // would put the words "AudioVolumeUp" into whatever has focus.
  assert.equal(translateKey(press('AudioVolumeUp')), null);
  assert.equal(translateKey(press('')), null);
  assert.equal(translateKey(null), null);
});

test('modifiersOf lists every held modifier in a stable order', () => {
  const all = press('a', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true });
  assert.deepEqual(modifiersOf(all), ['ctrl', 'alt', 'shift', 'meta']);
  assert.deepEqual(modifiersOf(press('a')), []);
});
