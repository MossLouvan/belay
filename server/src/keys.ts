// Maps the key names the app sends to the host platform's key codes, and
// modifier names to their codes. Anything not in the map is handled as literal
// text by the caller instead.
//
// Windows uses Win32 virtual-key codes; macOS uses Carbon CGKeyCodes. The two
// numbering schemes have nothing in common, so the tables are separate and the
// exported `VK` / `MOD_VK` / `charToVk` are bound to the running platform. The
// exported shape is identical on both, so callers never branch on platform.

const isDarwin = process.platform === 'darwin';

// ---- Windows: Win32 virtual-key codes ------------------------------------

export const WINDOWS_VK: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  delete: 0x2e,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  win: 0x5b,
};

export const WINDOWS_MOD_VK: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b,
  meta: 0x5b,
};

// ---- macOS: Carbon CGKeyCodes (Events.h kVK_*) ---------------------------

/** Modifier key codes, also understood by the Swift helper's flag mapping. */
const MAC_MODIFIER = {
  command: 0x37,
  shift: 0x38,
  option: 0x3a,
  control: 0x3b,
} as const;

export const DARWIN_VK: Record<string, number> = {
  backspace: 0x33, // kVK_Delete — the key labelled "delete" on an Apple keyboard
  tab: 0x30,
  enter: 0x24, // kVK_Return
  escape: 0x35,
  space: 0x31,
  pageup: 0x74,
  pagedown: 0x79,
  end: 0x77,
  home: 0x73,
  left: 0x7b,
  up: 0x7e,
  right: 0x7c,
  down: 0x7d,
  delete: 0x75, // kVK_ForwardDelete
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61,
  f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f,
  win: MAC_MODIFIER.command,
  cmd: MAC_MODIFIER.command,
  command: MAC_MODIFIER.command,
  option: MAC_MODIFIER.option,
  control: MAC_MODIFIER.control,
};

/**
 * Does `ctrl` from the phone mean Control or Command on a Mac?
 *
 * Default is Command. The phone's on-screen keys are labelled for the Windows
 * host they were written against, so `ctrl+c` means "copy" to the person
 * pressing it — and on macOS that is Cmd+C. Sending literal Control+C instead
 * would send SIGINT to the foreground process, which is both surprising and
 * destructive.
 *
 * Set `TETHER_MAC_CTRL=control` to send literal Control instead (the right
 * choice if you mostly drive a terminal). Either way, `rawctrl` always sends
 * literal Control and `cmd` always sends Command, so both are reachable
 * whichever default is configured.
 */
const ctrlMapsToCommand = (process.env.TETHER_MAC_CTRL || 'cmd').toLowerCase() !== 'control';
const CTRL_TARGET = ctrlMapsToCommand ? MAC_MODIFIER.command : MAC_MODIFIER.control;

export const DARWIN_MOD_VK: Record<string, number> = {
  ctrl: CTRL_TARGET,
  control: CTRL_TARGET,
  rawctrl: MAC_MODIFIER.control,
  alt: MAC_MODIFIER.option,
  option: MAC_MODIFIER.option,
  opt: MAC_MODIFIER.option,
  shift: MAC_MODIFIER.shift,
  win: MAC_MODIFIER.command,
  meta: MAC_MODIFIER.command,
  cmd: MAC_MODIFIER.command,
  command: MAC_MODIFIER.command,
};

/**
 * Printable characters on the US ANSI layout. macOS key codes are positional,
 * not character based, so this table only holds for a US-like layout — but it
 * is only used for shortcut composition (`cmd+c`). Arbitrary typed text goes
 * through the helper's `text` command, which injects Unicode directly and is
 * layout independent.
 */
const DARWIN_CHAR_KEYS: Record<string, number> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07,
  c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10,
  t: 0x11, o: 0x1f, u: 0x20, i: 0x22, p: 0x23, l: 0x25, j: 0x26, k: 0x28,
  n: 0x2d, m: 0x2e,
  '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15, '5': 0x17, '6': 0x16,
  '7': 0x1a, '8': 0x1c, '9': 0x19, '0': 0x1d,
};

// ---- platform-bound exports ----------------------------------------------

export const VK: Record<string, number> = isDarwin ? DARWIN_VK : WINDOWS_VK;
export const MOD_VK: Record<string, number> = isDarwin ? DARWIN_MOD_VK : WINDOWS_MOD_VK;

/**
 * A single printable letter/number can be sent as a key code so it composes
 * with modifiers (e.g. ctrl+c). On Windows letters map to their uppercase
 * ASCII VK; on macOS they map to the positional CGKeyCode.
 */
export function charToVk(ch: string): number | null {
  if (ch.length !== 1) return null;
  if (isDarwin) return DARWIN_CHAR_KEYS[ch.toLowerCase()] ?? null;
  const c = ch.toUpperCase().charCodeAt(0);
  if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c;
  return null;
}
