// What each accessory key sends, and what the Ctrl/Alt modifiers do to it.
// Pure data and pure functions, kept apart from the components that draw them
// so the encoding can be tested without a renderer.

export interface KeyDef {
  /** Stable id — also the testID suffix, so `qkey-Tab` never moves. */
  readonly id: string;
  readonly label: string;
  /** Bytes to send. Absent for modifier toggles and local actions. */
  readonly send?: string;
  readonly wide?: boolean;
}

export const PRIMARY_KEYS: readonly KeyDef[] = [
  { id: 'Esc', label: 'esc', send: '\x1b' },
  { id: 'Tab', label: 'tab', send: '\t' },
  { id: 'Enter', label: '⏎', send: '\r' },
  { id: 'Left', label: '←', send: '\x1b[D' },
  { id: 'Up', label: '↑', send: '\x1b[A' },
  { id: 'Down', label: '↓', send: '\x1b[B' },
  { id: 'Right', label: '→', send: '\x1b[C' },
  { id: 'Ctrl+C', label: '^C', send: '\x03' },
  { id: 'Ctrl+D', label: '^D', send: '\x04' },
];

export const SYMBOL_KEYS: readonly string[] = [
  '|', '~', '/', '\\', '-', '_', '$', '*', '&', '^', '%', '#', '!', '?', ':', ';',
  '"', "'", '`', '(', ')', '[', ']', '{', '}', '<', '>', '=', '+', '@', '.', ',',
];

export const LETTER_KEYS: readonly string[] = 'abcdefghijklmnopqrstuvwxyz'.split('');

export interface Modifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
}

const ARROW_RE = /^\x1b\[([ABCD])$/;

/** The xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). */
const modifierParam = (mods: Modifiers): number => 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);

/**
 * The control byte for `Ctrl+<ch>`, or null when the character has no control
 * form. `?` is the exception to the `& 0x1f` rule: `Ctrl+?` is DEL (0x7f), not
 * US (0x1f) — that is what a terminal sends and what readline expects.
 */
function controlByte(ch: string): string | null {
  const code = ch.toLowerCase().charCodeAt(0);
  if (code === 63) return '\x7f';
  if (code >= 64 && code <= 127) return String.fromCharCode(code & 0x1f);
  return null;
}

/**
 * Applies the armed modifiers to the bytes a key would send.
 *
 * Modifiers apply to whatever key is pressed next, not only to the letter and
 * symbol row: arming Ctrl and then tapping Tab used to send a bare Tab and
 * leave Ctrl armed, so the *following* keypress silently picked up a control
 * mapping the user never asked for. Arrows get the standard `CSI 1 ; m <final>`
 * encoding (Ctrl+Left is a word jump in every readline shell); anything with no
 * meaningful modified form is sent unchanged. Either way the modifier is
 * consumed — `KeyBar` clears it on every press.
 */
export function encodeKey(send: string, mods: Modifiers): string {
  if (!mods.ctrl && !mods.alt) return send;
  const arrow = ARROW_RE.exec(send);
  if (arrow) return `\x1b[1;${modifierParam(mods)}${arrow[1]}`;
  const controlled = mods.ctrl && send.length === 1 ? controlByte(send) ?? send : send;
  return mods.alt ? `\x1b${controlled}` : controlled;
}
