// Unit tests for keyboard translation.
//
// The two mistakes worth guarding: sending a shortcut as literal text (ctrl+c
// typing the letter c into the document instead of copying), and sending a
// shifted character as a key combination (shift+4 arriving as "4" because the
// host re-derived the character from a US layout).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { translateKey, modifiersOf } from '../src/keymap.js';
import { modifierMap } from '../src/modmap.js';

function press(key, mods = {}) {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

const MAC_TO_WIN = modifierMap(true, 'win32', 'remap');
const MAC_TO_WIN_VERBATIM = modifierMap(true, 'win32', 'verbatim');
const WIN_TO_MAC = modifierMap(false, 'darwin', 'remap');
const MAC_TO_MAC = modifierMap(true, 'darwin', 'remap');

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

// ---- with a modifier map -------------------------------------------------

test('mac driving windows: ⌘C is Ctrl+C, not the Start menu', () => {
  const out = translateKey(press('c', { metaKey: true }), MAC_TO_WIN);
  assert.deepEqual(out, { kind: 'key', key: 'c', mods: ['ctrl'] });
});

test('mac driving windows: ⌥ chords are Win chords, recovered from the physical key', () => {
  // Option composed before the browser told us anything: ⌥E arrives as a dead
  // key. Only `code` still knows which key it was, and Win+E must not degrade
  // into nothing — or worse, into the text "Dead".
  const dead = { ...press('Dead', { altKey: true }), code: 'KeyE' };
  assert.deepEqual(translateKey(dead, MAC_TO_WIN), { kind: 'key', key: 'e', mods: ['win'] });

  const composed = { ...press('å', { altKey: true }), code: 'KeyA' };
  assert.deepEqual(translateKey(composed, MAC_TO_WIN), { kind: 'key', key: 'a', mods: ['win'] });

  const digit = { ...press('¡', { altKey: true }), code: 'Digit1' };
  assert.deepEqual(translateKey(digit, MAC_TO_WIN), { kind: 'key', key: '1', mods: ['win'] });
});

test('mac driving windows: ⌃ carries the displaced Alt role', () => {
  // Alt+Tab and Alt+F4 live on ⌃ — the cost of giving ⌥ to the Windows key.
  assert.deepEqual(
    translateKey(press('Tab', { ctrlKey: true }), MAC_TO_WIN),
    { kind: 'key', key: 'tab', mods: ['alt'] },
  );
  assert.deepEqual(
    translateKey(press('F4', { ctrlKey: true }), MAC_TO_WIN),
    { kind: 'key', key: 'f4', mods: ['alt'] },
  );
  // A menu accelerator: ⌃F is one key with alt held, never the text "f".
  assert.deepEqual(
    translateKey(press('f', { ctrlKey: true }), MAC_TO_WIN),
    { kind: 'key', key: 'f', mods: ['alt'] },
  );
});

test('mac driving windows, verbatim: ⌥ still types é and ⌘ is the Win key', () => {
  assert.deepEqual(
    translateKey({ ...press('é', { altKey: true }), code: 'KeyE' }, MAC_TO_WIN_VERBATIM),
    { kind: 'text', text: 'é' },
  );
  assert.deepEqual(
    translateKey(press('e', { metaKey: true }), MAC_TO_WIN_VERBATIM),
    { kind: 'key', key: 'e', mods: ['win'] },
  );
});

test('windows driving mac: Ctrl+C copies instead of interrupting a terminal', () => {
  assert.deepEqual(
    translateKey(press('c', { ctrlKey: true }), WIN_TO_MAC),
    { kind: 'key', key: 'c', mods: ['cmd'] },
  );
  // The Win key is the road back to literal Control when it is really wanted.
  assert.deepEqual(
    translateKey(press('c', { metaKey: true }), WIN_TO_MAC),
    { kind: 'key', key: 'c', mods: ['rawctrl'] },
  );
});

test('windows driving mac: Alt stays Option, so AltGr characters stay text', () => {
  // On a Windows keyboard Alt alone plus a printable is not promoted to a
  // chord — that is how AltGr layouts type @ and €.
  assert.deepEqual(translateKey(press('@', { altKey: true }), WIN_TO_MAC), { kind: 'text', text: '@' });
});

test('mac driving mac: modifiers pass through in unambiguous spellings', () => {
  assert.deepEqual(
    translateKey(press('c', { metaKey: true }), MAC_TO_MAC),
    { kind: 'key', key: 'c', mods: ['cmd'] },
  );
  // ⌃C must reach a remote terminal as literal Control, immune to the host's
  // phone-oriented ctrl→cmd default.
  assert.deepEqual(
    translateKey(press('c', { ctrlKey: true }), MAC_TO_MAC),
    { kind: 'key', key: 'c', mods: ['rawctrl'] },
  );
  // ⌥ still composes: typing é on a remote Mac stays text.
  assert.deepEqual(
    translateKey({ ...press('é', { altKey: true }), code: 'KeyE' }, MAC_TO_MAC),
    { kind: 'text', text: 'é' },
  );
});

test('every held modifier is translated in a combined chord', () => {
  const out = translateKey(
    press('s', { metaKey: true, shiftKey: true }),
    MAC_TO_WIN,
  );
  assert.deepEqual(out, { kind: 'key', key: 's', mods: ['shift', 'ctrl'] });
  const winShift = translateKey(
    { ...press('ß', { altKey: true, shiftKey: true }), code: 'KeyS' },
    MAC_TO_WIN,
  );
  assert.deepEqual(winShift, { kind: 'key', key: 's', mods: ['win', 'shift'] });
});

test('modifiersOf speaks the map, for clicks as much as keys', () => {
  const event = press('', { metaKey: true, shiftKey: true });
  assert.deepEqual(modifiersOf(event, MAC_TO_WIN), ['shift', 'ctrl']);
  assert.deepEqual(modifiersOf(press('', { ctrlKey: true }), WIN_TO_MAC), ['cmd']);
});
