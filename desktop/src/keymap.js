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
// So: a shortcut (ctrl or meta held) becomes a key event, and anything that
// produced a printable character becomes text. Shift alone is deliberately not
// treated as a shortcut modifier — shift+4 already produced "$", and sending it
// as key(4, [shift]) would make the host re-derive a character the browser
// already worked out correctly for the user's own keyboard layout.

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

/** Modifier names as the host's MOD_VK table spells them. */
export function modifiersOf(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('ctrl');
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  if (event.metaKey) mods.push('meta');
  return mods;
}

/**
 * What to send for one keydown, or null to send nothing.
 *
 * Null covers two distinct cases that both mean "not a keystroke to forward":
 * a modifier key pressed on its own (it travels as a `mods` entry on the key it
 * modifies, and sending it alone would latch nothing but cost a round trip),
 * and any key this map does not recognise.
 */
export function translateKey(event) {
  const key = event?.key;
  if (typeof key !== 'string' || key === '') return null;
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return null;

  const mods = modifiersOf(event);
  const named = NAMED_KEYS[key];
  if (named) return { kind: 'key', key: named, mods };

  // A shortcut: the character is the *name* of the key being combined, not
  // text to insert. Lowercased because the host looks names up in lower case,
  // and ctrl+shift+A must stay one key plus two modifiers.
  if (key.length === 1 && (event.ctrlKey || event.metaKey)) {
    return { kind: 'key', key: key.toLowerCase(), mods };
  }

  // Printable, including anything a dead key or IME composed. `length === 1`
  // is not enough on its own — astral characters (emoji) are two UTF-16 code
  // units and would be dropped by a length test.
  if (key.length === 1 || [...key].length === 1) return { kind: 'text', text: key };

  return null;
}
