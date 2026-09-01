// Unit tests for the modifier map — every client/host direction, both modes.
//
// Two invariants matter more than any single entry. Every name a map can emit
// must exist in the host's MOD_VK table (an unknown name is silently dropped
// server-side, so the chord arrives without its modifier), and a map bound
// for a Mac host must never say `ctrl` — that name is rewritten by the host's
// own DESKHANDLER_MAC_CTRL remap, and two remaps deciding the same keystroke is
// how a keyboard becomes unpredictable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bareTapKey, isCommandRole, legendOf, legendText, modifierMap } from '../src/modmap.js';

// Mirrors server/src/keys.ts WINDOWS_MOD_VK / DARWIN_MOD_VK. Pinned here so a
// renamed key on either side fails a test instead of degrading silently.
const WINDOWS_MOD_NAMES = ['ctrl', 'control', 'alt', 'shift', 'win', 'meta'];
const DARWIN_MOD_NAMES = [
  'ctrl', 'control', 'rawctrl', 'alt', 'option', 'opt', 'shift',
  'win', 'meta', 'cmd', 'command',
];

const roles = (map) => [map.ctrl, map.alt, map.meta, map.shift];

test('mac driving windows: the remap puts copy on ⌘ and Start on ⌥', () => {
  const map = modifierMap(true, 'win32', 'remap');
  assert.equal(map.ctrl, 'alt');
  assert.equal(map.alt, 'win');
  assert.equal(map.meta, 'ctrl');
  assert.equal(map.shift, 'shift');
  assert.equal(map.adjustable, true);
  assert.equal(map.altComposes, true);
});

test('mac driving windows: the remap is a rotation, nothing unreachable', () => {
  // Alt moved off Option to make room for the Windows key; ⌃ picks it up. If
  // any role appeared twice, some Windows modifier would be unreachable.
  const map = modifierMap(true, 'win32', 'remap');
  assert.deepEqual([...new Set(roles(map))].sort(), ['alt', 'ctrl', 'shift', 'win']);
});

test('mac driving windows, verbatim: each key means itself', () => {
  const map = modifierMap(true, 'win32', 'verbatim');
  assert.deepEqual(roles(map), ['ctrl', 'alt', 'win', 'shift']);
});

test('windows driving mac: Ctrl becomes ⌘ and literal Control stays reachable', () => {
  const map = modifierMap(false, 'darwin', 'remap');
  assert.equal(map.ctrl, 'cmd');
  assert.equal(map.meta, 'rawctrl');
  assert.equal(map.alt, 'alt');
  assert.equal(map.adjustable, true);
  assert.equal(map.altComposes, false);
});

test('windows driving mac, verbatim: literal Control, not the host remap', () => {
  // `rawctrl`, never `ctrl`: verbatim must mean what it says even on a host
  // whose DESKHANDLER_MAC_CTRL default would rewrite `ctrl` into Command.
  const map = modifierMap(false, 'darwin', 'verbatim');
  assert.deepEqual(roles(map), ['rawctrl', 'alt', 'cmd', 'shift']);
});

test('same platform on both ends needs no translation and offers no toggle', () => {
  for (const mode of ['remap', 'verbatim']) {
    const macToMac = modifierMap(true, 'darwin', mode);
    assert.deepEqual(roles(macToMac), ['rawctrl', 'alt', 'cmd', 'shift']);
    assert.equal(macToMac.adjustable, false);

    const winToWin = modifierMap(false, 'win32', mode);
    assert.deepEqual(roles(winToWin), ['ctrl', 'alt', 'win', 'shift']);
    assert.equal(winToWin.adjustable, false);
  }
});

test('an unknown host platform gets the legacy wire names untouched', () => {
  for (const platform of ['', 'other', 'linux', undefined]) {
    for (const clientIsMac of [true, false]) {
      const map = modifierMap(clientIsMac, platform, 'remap');
      assert.deepEqual(roles(map), ['ctrl', 'alt', 'meta', 'shift']);
      assert.equal(map.adjustable, false);
    }
  }
});

test('every emitted name resolves in the host MOD_VK table it is bound for', () => {
  for (const clientIsMac of [true, false]) {
    for (const mode of ['remap', 'verbatim']) {
      for (const name of roles(modifierMap(clientIsMac, 'win32', mode))) {
        assert.ok(WINDOWS_MOD_NAMES.includes(name), `"${name}" unknown to a Windows host`);
      }
      for (const name of roles(modifierMap(clientIsMac, 'darwin', mode))) {
        assert.ok(DARWIN_MOD_NAMES.includes(name), `"${name}" unknown to a Mac host`);
      }
    }
  }
});

test('a mac host is only ever spoken to in unambiguous spellings', () => {
  for (const clientIsMac of [true, false]) {
    for (const mode of ['remap', 'verbatim']) {
      const map = modifierMap(clientIsMac, 'darwin', mode);
      assert.ok(!roles(map).includes('ctrl'), 'ctrl is the name DESKHANDLER_MAC_CTRL rewrites');
      assert.ok(!roles(map).includes('meta'));
    }
  }
});

test('command roles: the names that make a chord, and only those', () => {
  for (const role of ['ctrl', 'meta', 'win', 'cmd', 'rawctrl']) {
    assert.equal(isCommandRole(role), true, role);
  }
  for (const role of ['alt', 'option', 'shift', '', undefined]) {
    assert.equal(isCommandRole(role), false, String(role));
  }
});

test('a bare tap becomes the Windows key only where a modifier carries it', () => {
  const remap = modifierMap(true, 'win32', 'remap');
  assert.equal(bareTapKey('Alt', remap), 'win'); // the owner's ask: ⌥ taps Start
  assert.equal(bareTapKey('Meta', remap), null);
  assert.equal(bareTapKey('Control', remap), null);
  assert.equal(bareTapKey('Shift', remap), null);

  const verbatim = modifierMap(true, 'win32', 'verbatim');
  assert.equal(bareTapKey('Meta', verbatim), 'win'); // ⌘ is the Win key here
  assert.equal(bareTapKey('Alt', verbatim), null);

  // No modifier does anything alone on a Mac host; tapping must stay silent.
  for (const key of ['Control', 'Alt', 'Meta', 'Shift']) {
    assert.equal(bareTapKey(key, modifierMap(false, 'darwin', 'remap')), null);
  }
});

test('the legend states exactly the modifiers that stopped meaning themselves', () => {
  const macWin = legendOf(modifierMap(true, 'win32', 'remap'));
  assert.deepEqual(macWin, [
    { press: '⌘', sends: 'Ctrl' },
    { press: '⌥', sends: 'Win' },
    { press: '⌃', sends: 'Alt' },
  ]);
  assert.equal(legendText(modifierMap(true, 'win32', 'remap')), '⌘ sends Ctrl · ⌥ sends Win · ⌃ sends Alt');

  const winMac = legendOf(modifierMap(false, 'darwin', 'remap'));
  assert.deepEqual(winMac, [
    { press: 'Win', sends: '⌃' },
    { press: 'Ctrl', sends: '⌘' },
  ]);

  // Nothing translated, nothing claimed.
  assert.equal(legendText(modifierMap(true, 'win32', 'verbatim')), '');
  assert.equal(legendText(modifierMap(true, 'darwin', 'remap')), '');
  assert.equal(legendText(modifierMap(false, '', 'remap')), '');
});
