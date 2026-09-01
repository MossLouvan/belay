// Classifying the host's monitors.
//
// The native helpers report what the OS says about each display and judge
// nothing (see native/BelayHostDisplays.cs and native/mac/DisplayIdentity.swift).
// The judgement happens here, for two reasons: it is the kind of string
// heuristic that needs correcting as new virtual-display drivers appear, and
// changing it here costs a server restart rather than a recompile of a native
// binary on both platforms.
//
// The question worth answering is which displays are *virtual* — synthesized by
// a driver with no panel attached. Those are the ones a remote client can take
// over without stealing the screen from whoever is sitting at the host, which
// is what makes seamless remote windows tolerable to share a machine with.
//
// Two independent signals, because neither is sufficient alone:
//
//   1. The Windows device interface path. A real panel enumerates under
//      `DISPLAY#`; a software display has no bus to hang off and enumerates
//      under `ROOT#`. This is structural rather than cosmetic — a driver cannot
//      rename its way out of it — so it is checked first and trusted.
//   2. The adapter and monitor names. macOS exposes no equivalent enumerator,
//      so there the name is all there is; happily every virtual display tool
//      people actually run says so in its name.
//
// A false positive here is cosmetic (a label, and a display offered as a
// takeover target that a human might be using), never destructive: nothing in
// the capture or input path behaves differently because of this flag.

/** One display as the native helper reports it, before classification. */
export interface RawScreen {
  index: number;
  X: number;
  Y: number;
  W: number;
  H: number;
  primary: boolean;
  /** OS handle: `\.\DISPLAY1` on Windows, `CGDisplay <id>` on macOS. */
  device?: string | null;
  /** GPU / driver name: "NVIDIA GeForce RTX 4070", "Parsec Virtual Display Adapter". */
  adapter?: string | null;
  /** Panel name: "Generic PnP Monitor", "DELL U2720Q", "BetterDisplay Virtual". */
  monitor?: string | null;
  /** Device interface path (Windows) or a synthesized CGDisplay triple (macOS). */
  id?: string | null;
  /** macOS only: the laptop's own panel, which is never virtual. */
  builtin?: boolean;
  vendor?: number;
  model?: number;
}

export interface ClassifiedScreen extends RawScreen {
  /** Synthesized by a display driver, with no physical panel attached. */
  virtualDisplay: boolean;
  /** Short human name for a monitor picker: "Virtual Display", "DELL U2720Q". */
  label: string;
}

/**
 * Names that mean "this display is a software one".
 *
 * Every entry is a product that ships an indirect display driver people
 * actually install, plus the generic words those drivers use. Matched
 * case-insensitively against the adapter and monitor strings.
 *
 * Deliberately not on this list: "remote", "display link" and "airplay". A
 * DisplayLink dock and an AirPlay/Sidecar target are real, physically visible
 * screens someone may be looking at — offering them for takeover would hand a
 * remote client an iPad the owner is holding.
 */
const VIRTUAL_NAME_HINTS = [
  'virtual',
  'dummy',
  'headless',
  'iddsample',
  'idd driver',
  'indirect display',
  'parsec vda',
  'parsec vdd',
  'betterdisplay',
  'spacedesk',
  'usbmmidd',
  'amyuni',
  'vdd by',
  'sunshine',
  'deskreen',
  // Names its display "DeskPad Display" — no other hint here would match it.
  'deskpad',
] as const;

/**
 * The Windows device-interface enumerator for software-enumerated devices.
 *
 * Compared after normalizing the leading `\?\`, whose backslashes survive a
 * JSON round trip doubled and are easy to get wrong in a literal.
 */
const ROOT_ENUMERATOR = /^\\\?\root#/i;

function hasVirtualName(...values: (string | null | undefined)[]): boolean {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const lower = value.toLowerCase();
    if (VIRTUAL_NAME_HINTS.some((hint) => lower.includes(hint))) return true;
  }
  return false;
}

/**
 * Whether a display is virtual.
 *
 * The built-in check comes first and is absolute: a MacBook's own panel can
 * contain any word at all in its name and is still the screen the owner is
 * looking at.
 */
export function isVirtualDisplay(screen: RawScreen): boolean {
  if (screen.builtin === true) return false;
  if (typeof screen.id === 'string' && ROOT_ENUMERATOR.test(screen.id)) return true;
  return hasVirtualName(screen.adapter, screen.monitor);
}

/**
 * A short name for the monitor picker.
 *
 * Prefers the panel name over the adapter, because the adapter is shared by
 * every display on one GPU and so cannot distinguish them. "Generic PnP
 * Monitor" is the Windows default for a panel with nothing better to say —
 * it identifies nothing, so it is dropped in favour of the numbered fallback.
 */
export function screenLabel(screen: RawScreen): string {
  const monitor = typeof screen.monitor === 'string' ? screen.monitor.trim() : '';
  if (monitor && monitor.toLowerCase() !== 'generic pnp monitor') return monitor;
  const adapter = typeof screen.adapter === 'string' ? screen.adapter.trim() : '';
  if (adapter && isVirtualDisplay(screen)) return adapter;
  return `Display ${screen.index + 1}`;
}

/**
 * Classify every screen in a helper's `info` reply.
 *
 * Tolerant of a helper that reports no screens at all (an older build, or a
 * platform without the multi-monitor path): the reply passes through untouched
 * rather than growing an empty list, so clients keep distinguishing "this host
 * cannot enumerate monitors" from "this host has none".
 */
export function classifyScreens<T extends { screens?: RawScreen[] }>(
  info: T,
): Omit<T, 'screens'> & { screens?: ClassifiedScreen[] } {
  type Classified = Omit<T, 'screens'> & { screens?: ClassifiedScreen[] };
  // The cast covers exactly the branch where `screens` is absent, so the
  // property the return type describes is genuinely not there to be wrong.
  if (!Array.isArray(info.screens)) return info as Classified;
  return {
    ...info,
    screens: info.screens.map((screen) => ({
      ...screen,
      virtualDisplay: isVirtualDisplay(screen),
      label: screenLabel(screen),
    })),
  } as Classified;
}
