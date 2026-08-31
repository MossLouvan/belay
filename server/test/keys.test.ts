// Unit tests for the key-name → key-code tables.
//
// The app's key bar promises that a cap does the equivalent thing on either
// host. That promise dies quietly if a name the app sends is missing from a
// table: /input/key falls back to typing the name as literal text, so a
// missing "printscreen" would type the word "printscreen" into whatever has
// focus. These tests pin every name the shortcut caps send, per platform.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WINDOWS_VK,
  WINDOWS_MOD_VK,
  DARWIN_VK,
  DARWIN_MOD_VK,
  charToVk,
} from '../src/keys.js';

/** The windows-side charToVk rule: letters/digits map to uppercase ASCII. */
const winChar = (ch: string): number => ch.toUpperCase().charCodeAt(0);

test('printscreen resolves on Windows to VK_SNAPSHOT', () => {
  assert.equal(WINDOWS_VK.printscreen, 0x2c);
});

test('printscreen is deliberately absent from the Darwin table', () => {
  // The app never sends it to a Mac (the Shot cap sends ⌘⇧3 there instead).
  // Were an entry added it would have to invent a key code Apple never
  // defined; absence means an unexpected send degrades to typed text, which
  // is at least visible.
  assert.equal(DARWIN_VK.printscreen, undefined);
});

test('every chord the key bar sends to a Windows host resolves', () => {
  // Mirrors app/src/screen/model.ts KEYS (the windows variants).
  const chords: readonly (readonly [number | undefined, readonly string[]])[] = [
    [winChar('t'), ['ctrl']], // new tab
    [winChar('w'), ['ctrl']], // close tab
    [winChar('s'), ['ctrl']], // save
    [winChar('f'), ['ctrl']], // find
    [WINDOWS_VK.win, []], // search (Start)
    [winChar('s'), ['win', 'shift']], // region snip
    [WINDOWS_VK.printscreen, ['win']], // full-screen shot
    [WINDOWS_VK.f4, ['alt']], // quit
    [winChar('l'), ['win']], // lock
  ];
  for (const [vk, mods] of chords) {
    assert.equal(typeof vk, 'number');
    for (const mod of mods) {
      assert.equal(typeof WINDOWS_MOD_VK[mod], 'number', `windows modifier "${mod}" missing`);
    }
  }
});

test('every chord the key bar sends to a Mac host resolves', () => {
  // The letter/digit keys ride charToVk on darwin; assert the table entries
  // directly on any platform, and the charToVk path too when running there.
  const chars = ['t', 'w', 's', 'f', '4', '3', 'q'];
  if (process.platform === 'darwin') {
    for (const ch of chars) {
      assert.equal(typeof charToVk(ch), 'number', `darwin char "${ch}" missing`);
    }
  }
  assert.equal(typeof DARWIN_VK.space, 'number'); // search (⌘Space)
  for (const mod of ['cmd', 'shift', 'rawctrl', 'alt', 'ctrl', 'win']) {
    assert.equal(typeof DARWIN_MOD_VK[mod], 'number', `darwin modifier "${mod}" missing`);
  }
});

test('rawctrl always means literal Control, whatever ctrl is remapped to', () => {
  // The Lock cap depends on this: macOS locks on ⌃⌘Q, and with the default
  // ctrl→cmd remap a plain "ctrl" would collapse the chord into ⌘⌘Q.
  assert.equal(DARWIN_MOD_VK.rawctrl, 0x3b); // kVK_Control
  assert.notEqual(DARWIN_MOD_VK.rawctrl, DARWIN_MOD_VK.cmd);
});
