// Pure monitor-selection logic for the remote-screen tab.
//
// The host captures ONE monitor per frame and maps every normalized input
// coordinate onto that same monitor's rectangle. These helpers keep the app's
// side of that contract honest: sanitize the untrusted screens list, pick the
// default (the primary), and keep a user's selection valid when the list
// changes — so the monitor being viewed and the monitor receiving input can
// never drift apart.
//
// For reference, the host (BelayHost.cs MoveAbsolute) maps a normalized tap
// (nx, ny) onto the selected monitor S inside the virtual desktop V as:
//
//   vx = S.X + nx * S.W                       // pixel within the desktop
//   dx = round((vx - V.X) / (V.W - 1) * 65535) // SendInput absolute coordinate
//
// Worked two-monitor example (both 1920x1080, primary on the RIGHT):
//   V = { X:0, W:3840 },  S = primary = { X:1920, W:1920 },  nx = 0.5
//   vx = 1920 + 0.5 * 1920 = 2880
//   dx = round(2880 / 3839 * 65535) = 49164   -> centre of the right monitor.
// The old code computed dx = 0.5 * 65535 = 32768 — the seam between the two
// monitors, a full screen to the left of where the frame showed the tap.

// Type-only, and marked as such: the tests run this file under Node's type
// stripping, where a value-style import of a type would fail at runtime.
import type { ScreenInfo } from '../api';

export interface MonitorChoice {
  readonly index: number;
  readonly primary: boolean;
  readonly w: number;
  readonly h: number;
  /** Host's verdict that this display is a driver-synthesized one. */
  readonly virtual: boolean;
  /** Host-supplied name, or '' when the host is too old to send one. */
  readonly name: string;
}

/**
 * The host's monitor list, sanitized.
 *
 * Anything malformed is dropped rather than repaired: an entry whose index is
 * missing or negative cannot be requested, and a host that predates the
 * multi-monitor work sends no list at all — both collapse to [], which the UI
 * reads as "no switcher, send no index" (the host then uses its primary).
 */
export function screensOf(info: Pick<ScreenInfo, 'screens'> | null): MonitorChoice[] {
  const raw = info?.screens;
  if (!Array.isArray(raw)) return [];
  const out: MonitorChoice[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { index, primary, W, H, virtualDisplay, label } = entry as {
      index?: unknown; primary?: unknown; W?: unknown; H?: unknown;
      virtualDisplay?: unknown; label?: unknown;
    };
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    if (out.some((s) => s.index === index)) continue; // duplicates are hostile
    out.push({
      index,
      primary: primary === true,
      w: typeof W === 'number' && Number.isFinite(W) && W > 0 ? W : 0,
      h: typeof H === 'number' && Number.isFinite(H) && H > 0 ? H : 0,
      // Both default to "no claim": an old host says nothing about either, and
      // a monitor with no name must not be described as virtual by omission.
      virtual: virtualDisplay === true,
      name: typeof label === 'string' ? label.slice(0, 64) : '',
    });
  }
  return out;
}

/** The monitor to show first: the primary, or failing that the first listed. */
export function defaultScreenIndex(screens: readonly MonitorChoice[]): number | undefined {
  if (screens.length === 0) return undefined;
  return (screens.find((s) => s.primary) ?? screens[0]).index;
}

/**
 * Resolve what the user picked against what the host currently reports.
 *
 * - No list (old host, or not loaded yet): undefined — send no index, so the
 *   host falls back to its primary exactly as it always has.
 * - Selection still listed: keep it.
 * - Selection gone (monitor unplugged) or never made: the default.
 */
export function resolveScreenIndex(
  selected: number | undefined,
  screens: readonly MonitorChoice[],
): number | undefined {
  if (screens.length === 0) return undefined;
  if (selected !== undefined && screens.some((s) => s.index === selected)) return selected;
  return defaultScreenIndex(screens);
}

/**
 * The monitor after the current one, in list order, wrapping — the dock's
 * monitor button cycles with a tap. Resolves the selection first, so a stale
 * index cycles from the effective monitor rather than from monitor 1.
 */
export function nextScreenIndex(
  selected: number | undefined,
  screens: readonly MonitorChoice[],
): number | undefined {
  if (screens.length === 0) return undefined;
  const resolved = resolveScreenIndex(selected, screens);
  const at = screens.findIndex((s) => s.index === resolved);
  return screens[(at + 1) % screens.length].index;
}

/** Short human label for the switcher: 1-based, primary marked. */
export function monitorLabel(screen: MonitorChoice): string {
  return `${screen.index + 1}${screen.primary ? ' (main)' : ''}`;
}

/**
 * The full name for a picker with room for one: "2 · Virtual Display".
 *
 * Falls back to the terse switcher label when the host sent no name, so this is
 * safe to use everywhere rather than only against new hosts.
 */
export function monitorDescription(screen: MonitorChoice): string {
  const suffix = screen.name || (screen.virtual ? 'Virtual display' : '');
  return suffix ? `${monitorLabel(screen)} · ${suffix}` : monitorLabel(screen);
}

/**
 * The virtual display to hand a desktop client, if the host has one.
 *
 * The first is enough: a host with two virtual displays is already an
 * unusual setup, and picking between them is the user's call, not a default's.
 */
export function virtualScreen(screens: readonly MonitorChoice[]): MonitorChoice | undefined {
  return screens.find((s) => s.virtual);
}
