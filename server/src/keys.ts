// Maps the key names the app sends to Win32 virtual-key codes, and modifier
// names to their VKs. Anything not in the map is handled as literal text by the
// caller instead.

export const VK: Record<string, number> = {
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

export const MOD_VK: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b,
  meta: 0x5b,
};

// A single printable letter/number can be sent as a virtual key so it composes
// with modifiers (e.g. ctrl+c). Letters map to their uppercase ASCII VK.
export function charToVk(ch: string): number | null {
  if (ch.length !== 1) return null;
  const c = ch.toUpperCase().charCodeAt(0);
  if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c;
  return null;
}
