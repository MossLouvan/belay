// Translating a browser KeyboardEvent into what the host's /input endpoints
// understand. Pure, so it is unit-tested rather than tested by typing at a
// real desktop and looking at what came out.
//
// The host accepts two different things and the choice between them is the
// whole problem:
//
//   /input/text  a literal string, typed as Unicode. Correct for characters,
//                including ones a modifier produced ("$" from shift+4) and
//                ones no key produces on its own (é, 中).
//   /input/key   a named key plus modifiers, mapped to a virtual-key code.
//                The only thing that can express a *shortcut* — ctrl+c has to
//                arrive as the C key with ctrl held, never as the text "c".
//
// So: a shortcut (a command-role modifier held) becomes a key event, and
// anything that produced a printable character becomes text. Shift alone is
// deliberately not treated as a shortcut modifier — shift+4 already produced
// "$", and sending it as key(4, [shift]) would make the host re-derive a
// character the browser already worked out correctly for the user's own
// keyboard layout.
//
// Every modifier travels through a modifierMap (modmap.js), which decides
// what each physical key *means* on this particular host — ⌘ as Ctrl when a
// Mac drives Windows, and so on. This file only decides key-versus-text; the
// map decides names.

import { isCommandRole, modifierMap } from './modmap.js';

/**
 * Named keys, keyed by KeyboardEvent.key.
 *
 * Only keys the host's VK table actually knows. A named key missing from here
 * falls through to the printable/ignored branches rather than being invented,
 * because the host answers an unknown name by *typing it as literal text* —
 * which is how an unmapped "AudioVolumeUp" would type the words into a
 * document.
 */
const NAMED_KEYS = {
  Backspace: 'backspace',
  Tab: 'tab',
  Enter: 'enter',
  Escape: 'escape',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  End: 'end',
  Home: 'home',
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowRight: 'right',
  ArrowDown: 'down',
  Delete: 'delete',
  F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
  F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
};

/** The map used when a caller supplies none: the pre-remap wire names. */
const LEGACY_MAP = modifierMap(false, 'other');

/** Held modifiers, spelled as the host must hear them under `map`. */
export function modifiersOf(event, map = LEGACY_MAP) {
  const mods = [];
  if (event.ctrlKey) mods.push(map.ctrl);
  if (event.altKey) mods.push(map.alt);
  if (event.shiftKey) mods.push(map.shift);
  if (event.metaKey) mods.push(map.meta);
  return mods;
}

/**
 * Whether this keydown is a chord, i.e. a command rather than a character.
 *
 * Physical Ctrl and Meta never compose characters, so holding either always
 * means a command — whatever role the map gives them. Alt only counts when
 * the map has promoted it to a command role (⌥ as the Windows key): left as
 * itself it is how a Mac keyboard types é, and how AltGr layouts type @.
 */
function isChord(event, map) {
  if (event.ctrlKey || event.metaKey) return true;
  return event.altKey && isCommandRole(map.alt);
}

/**
 * The base character under the finger, from the physical key position.
 *
 * Needed when Option is part of a chord: macOS composes before the event, so
 * ⌥E arrives with key "´" (or "Dead") and only `code` still says KeyE. Only
 * letters and digits are recovered — `code` names are positional and those
 * are the only rows where position and meaning agree across layouts, which
 * covers every Win-key chord worth sending (Win+E, Win+L, Win+1…9).
 */
function baseChar(code) {
  if (typeof code !== 'string') return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  return digit ? digit[1] : null;
}

/**
 * What to send for one keydown, or null to send nothing.
 *
 * Null covers two distinct cases that both mean "not a keystroke to forward":
 * a modifier key pressed on its own (it travels as a `mods` entry on the key it
 * modifies — a bare *tap* of a remapped Windows key is the renderer's job, see
 * bareTapKey), and any key this map does not recognise.
 */
export function translateKey(event, map = LEGACY_MAP) {
  const key = event?.key;
  if (typeof key !== 'string' || key === '') return null;
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return null;

  const mods = modifiersOf(event, map);
  const named = NAMED_KEYS[key];
  if (named) return { kind: 'key', key: named, mods };

  if (isChord(event, map)) {
    // The character is the *name* of the key being combined, not text to
    // insert. Lowercased because the host looks names up in lower case, and
    // ctrl+shift+A must stay one key plus two modifiers. When Option composed
    // the character before we saw it, the physical position is the truth.
    const composed = event.altKey && map.altComposes ? baseChar(event.code) : null;
    const name = composed ?? (key.length === 1 ? key.toLowerCase() : null);
    return name === null ? null : { kind: 'key', key: name, mods };
  }

  // Printable, including anything a dead key or IME composed. `length === 1`
  // is not enough on its own — astral characters (emoji) are two UTF-16 code
  // units and would be dropped by a length test.
  if (key.length === 1 || [...key].length === 1) return { kind: 'text', text: key };

  return null;
}
