// Design tokens for Deskhandler — the "Ledger" system (docs/DESIGN.md).
//
// Two palettes with one design language: light is "paper" (warm grey ground,
// near-black ink), dark is "ink" (the same page photographed in negative).
// A single orange accent replaced the old blue identity, and the card died:
// structure now comes from typography, hairline rules and the spacing scale,
// so the surface/elevation machinery below survives only as compatibility
// shims for screens that have not migrated yet. Plain objects and one tiny
// external store — no theming library, so the web bundle stays small and
// Expo Go stays happy.
//
// Backwards compatibility: the legacy named exports `colors`, `radius`, `space`
// and `font` still exist and `colors` still resolves to the dark palette, so
// screens written against the old API keep compiling. New code should call
// `useTheme()` and read `theme.colors` instead.

import { useCallback, useSyncExternalStore } from 'react';
import { Appearance, Platform, StyleSheet } from 'react-native';
import type { TextStyle } from 'react-native';

export type ColorScheme = 'light' | 'dark';
export type ThemeMode = 'system' | ColorScheme;

/**
 * Every colour role available to a screen. The first block is the legacy set
 * (kept name-compatible; two roles were repurposed by the Ledger redesign and
 * say so inline); the second block adds the semantic roles.
 */
export interface Palette {
  readonly bg: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly text: string;
  readonly textDim: string;
  readonly textFaint: string;
  readonly accent: string;
  /**
   * Repurposed: was "muted accent fill", now the disabled/track tint of the
   * accent — the segmented-underline track and disabled primary buttons.
   */
  readonly accentDim: string;
  readonly good: string;
  readonly warn: string;
  readonly bad: string;
  /** Repurposed: legacy alias of `machine`. New code reads `machine`. */
  readonly black: string;
  // Semantic roles.
  /**
   * The vivid accent for NON-TEXT marks at least 3pt thick: status dots,
   * selection underlines, progress fills, the streaming cursor. It clears the
   * WCAG 1.4.11 3:1 bar for UI marks but not the 4.5:1 text bar — text stays
   * on `accent`, which is tuned to pass it.
   */
  readonly accentGraphic: string;
  /**
   * The terminal/video panel ground. Deliberately near-black in BOTH themes:
   * a live desktop stream and a pty are windows into the computer, not UI
   * surfaces, and keeping them dark spares the terminal an ANSI-on-light
   * palette nobody maintains (docs/DESIGN.md §3.4).
   */
  readonly machine: string;
  readonly onMachine: string;
  readonly onMachineDim: string;
  readonly onAccent: string;
  readonly onDanger: string;
  readonly accentSoft: string;
  readonly goodSoft: string;
  readonly warnSoft: string;
  readonly badSoft: string;
  // Text/icon colours for content sitting ON the matching `*Soft` fill. The
  // solid status colours are only verified against the opaque surfaces, and a
  // translucent fill composited over `surfaceAlt` lifts the local background
  // enough to drop them under 4.5:1 — these roles exist so soft-filled
  // components never reuse the solid colour by mistake.
  readonly onAccentSoft: string;
  readonly onGoodSoft: string;
  readonly onWarnSoft: string;
  readonly onBadSoft: string;
  readonly overlay: string;
  readonly focus: string;
  readonly skeleton: string;
  /** @deprecated Dead with elevation — the design is flat. Kept so unmigrated
   * screens compile; remove with the `elevation` shim. */
  readonly shadow: string;
}

// Contrast verified with a WCAG 2.1 relative-luminance check against the worst
// case of { bg, surface, surfaceAlt }; `on*Soft` ratios are for the text
// composited over the soft fill composited over `surfaceAlt`. The verifier
// script lives in docs/DESIGN-TOKENS.md §9 — re-run it before changing any hex
// or alpha.

/** Light — "paper". Warm grey ground, near-black ink, burnt-orange accent. */
export const lightPalette: Palette = Object.freeze({
  bg: '#EAE8E4',
  surface: '#F2F1EE', // inputs only
  surfaceAlt: '#E1DED9', // recessed: keys, tracks, pressed rows
  border: '#C8C4BD', // hairlines (non-text)
  borderStrong: '#8F8A82', // emphasis rules only where ink 2pt is too loud
  text: '#161513', // >= 13.60:1
  textDim: '#4F4B45', // >= 6.45:1
  textFaint: '#615C55', // >= 4.94:1
  accent: '#B03700', // >= 4.61:1 (text-safe burnt orange)
  // Darkened from the spec's #E84A00, which passes 3:1 against bg (3.17) but
  // falls to 2.89 against surfaceAlt — and surfaceAlt is exactly where these
  // marks sit (the meter fill lives ON the surfaceAlt track). The spec's own
  // worst-case rule wins over its quoted hex; #DE4400 is the nearest vivid
  // orange that clears 3:1 on all three backdrops.
  accentGraphic: '#DE4400', // >= 3.17:1 worst-case — non-text marks only (WCAG 1.4.11)
  accentDim: 'rgba(176, 55, 0, 0.28)', // tracks/disabled fills, non-text
  good: '#0B6040', // >= 5.67:1
  warn: '#754C04', // >= 5.06:1
  bad: '#A82028', // >= 5.39:1
  black: '#0C0B0A', // alias of machine (legacy name)
  machine: '#0C0B0A',
  onMachine: '#ECEAE6', // 16.37:1 on machine
  onMachineDim: '#A9A49C', // 7.94:1 on machine
  onAccent: '#FFFFFF', // 5.9:1 on accent
  onDanger: '#FFFFFF', // 5.6:1 on bad
  accentSoft: 'rgba(176, 55, 0, 0.10)',
  goodSoft: 'rgba(11, 96, 64, 0.10)',
  warnSoft: 'rgba(117, 76, 4, 0.10)',
  badSoft: 'rgba(168, 32, 40, 0.10)',
  onAccentSoft: '#9A3000', // >= 4.85:1 composited over surfaceAlt
  onGoodSoft: '#095538', // >= 5.66:1
  onWarnSoft: '#6D4603', // >= 5.36:1
  onBadSoft: '#961E25', // >= 5.33:1
  overlay: 'rgba(22, 21, 19, 0.40)',
  focus: '#B03700',
  skeleton: '#DBD8D2',
  shadow: '#000000', // dead — see the Palette note
});

/** Dark — "ink". Warm near-black, not blue-black; the accent survives untamed. */
export const darkPalette: Palette = Object.freeze({
  bg: '#121110',
  surface: '#1A1917',
  surfaceAlt: '#232120',
  border: '#2E2C29',
  borderStrong: '#4A4741',
  text: '#ECEAE6', // >= 13.34:1
  textDim: '#A9A49C', // >= 6.47:1
  textFaint: '#928D84', // >= 4.86:1
  accent: '#FF5C1A', // >= 5.19:1
  accentGraphic: '#FF4D00', // >= 4.82:1 (non-text marks)
  accentDim: 'rgba(255, 92, 26, 0.30)',
  good: '#3DDC97', // >= 9.07:1 (kept from the previous palette, known-good)
  warn: '#F7B32B', // >= 8.73:1 (kept)
  bad: '#FF7A70', // >= 6.31:1 (lifted from #FF6B6B)
  black: '#0C0B0A',
  machine: '#0C0B0A',
  onMachine: '#ECEAE6', // 16.37:1
  onMachineDim: '#A9A49C', // 7.94:1
  onAccent: '#121110', // 6.1:1 on accent
  onDanger: '#121110', // 6.9:1
  accentSoft: 'rgba(255, 92, 26, 0.14)',
  goodSoft: 'rgba(61, 220, 151, 0.14)',
  warnSoft: 'rgba(247, 179, 43, 0.14)',
  badSoft: 'rgba(255, 122, 112, 0.14)',
  onAccentSoft: '#FF7A3D', // >= 5.17:1 composited over surfaceAlt
  onGoodSoft: '#3DDC97', // >= 6.77:1
  onWarnSoft: '#F7B32B', // >= 6.51:1
  onBadSoft: '#FF7A70', // >= 5.13:1
  overlay: 'rgba(0, 0, 0, 0.60)',
  focus: '#FF5C1A',
  skeleton: '#262421',
  shadow: '#000000', // dead — see the Palette note
});

/**
 * Square corners are the system: 2pt standard, 4pt only on key-bar keys.
 * The larger steps are deprecated aliases so unmigrated screens compile —
 * their values collapse to what the design allows, not what the name implies.
 */
export const radius = Object.freeze({
  xs: 2, // standard: inputs, buttons, soft-fill bands
  sm: 4, // key-bar keys only
  /** @deprecated Alias of `sm`. Migrate call sites to xs/sm, then delete. */
  md: 4,
  /** @deprecated Card radius; the card is dead. Delete after migration. */
  lg: 0,
  /** @deprecated Delete after migration. */
  xl: 0,
  /** @deprecated Pills are banned (docs/DESIGN.md §12). Delete after migration. */
  pill: 999,
});

/** Strict 4pt base. If a gap is not one of these, the layout is wrong. */
export const space = Object.freeze({
  none: 0,
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
});

export const font = Object.freeze({
  // Sans is the platform default (undefined fontFamily). Named here so a
  // future custom-font swap (Archivo Black / Space Mono, docs/DESIGN.md §4.1)
  // is one edit rather than a component sweep.
  sans: undefined as string | undefined,
  mono: Platform.select({
    ios: 'Menlo',
    default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }) as string,
});

/**
 * Type scale. Every entry is a ready-to-spread `TextStyle`. Typography IS the
 * hierarchy in this system — display/title carry weight 900 and negative
 * tracking (heavy grotesques need optical tightening at size), body drops to
 * regular (ink contrast carries legibility), and `label` — the single
 * most-used variant — is tracked uppercase mono, never bold, never above 11pt,
 * or the page turns into a shouting match (docs/DESIGN.md §4.3).
 */
export const type = Object.freeze({
  display: { fontSize: 40, lineHeight: 42, fontWeight: '900', letterSpacing: -1.5, textTransform: 'uppercase' },
  title: { fontSize: 28, lineHeight: 32, fontWeight: '900', letterSpacing: -0.6, textTransform: 'uppercase' },
  heading: { fontSize: 19, lineHeight: 24, fontWeight: '800', letterSpacing: -0.3 },
  subheading: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 17, fontWeight: '400' },
  // Hero stats ("39%"). Tabular numerals so live values do not jitter.
  numeral: { fontSize: 34, lineHeight: 38, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  label: { fontFamily: font.mono, fontSize: 11, lineHeight: 14, fontWeight: '400', letterSpacing: 1.5, textTransform: 'uppercase' },
  micro: { fontFamily: font.mono, fontSize: 10, lineHeight: 13, fontWeight: '400', letterSpacing: 1.2, textTransform: 'uppercase' },
  mono: { fontFamily: font.mono, fontSize: 13, lineHeight: 19 },
  monoSmall: { fontFamily: font.mono, fontSize: 11, lineHeight: 16 },
}) satisfies Readonly<Record<string, TextStyle>>;

export type TypeVariant = keyof typeof type;

/** Layout constants. 44pt is the Apple/WCAG minimum touch target. */
export const layout = Object.freeze({
  minTouch: 44,
  // A true 1px physical hairline — the structural rule that replaced every
  // card border. The old value of 1 rendered 2–3 physical pixels on retina.
  hairline: StyleSheet.hairlineWidth,
  /** The 2pt emphasis/selection rule — the only other rule weight allowed. */
  ruleEmphasis: 2,
  /** The page gutter. Every x-position is this margin, a column edge, or the
   * right margin — replaces ad-hoc `space.md` page padding. */
  margin: 20,
  /** Uniform list row minimum: the 44pt target plus breathing room, so dense
   * lists read as a table instead of a jumble. */
  rowHeight: 52,
  /**
   * Nominal tab bar height at the default text size. The bar itself measures
   * its own contents, adds the home-indicator inset, and grows with Dynamic
   * Type, so treat this as a floor for laying content out above the bar rather
   * than as the bar's actual height.
   */
  tabBarHeight: 61,
  contentMaxWidth: 680,
  hitSlop: Object.freeze({ top: 8, bottom: 8, left: 8, right: 8 }),
});

/**
 * Animation timings, in ms. Small, fast, honest: ease-out only, nothing over
 * `slow`, translations capped at 8pt. Screens must gate on `useReducedMotion()`
 * — translations become fades, pulse/blink hold full opacity, durations halve.
 */
export const motion = Object.freeze({
  instant: 0,
  fast: 120, // selection flips, underline slide
  base: 180, // presses, fades
  slow: 240, // sheet slide; nothing may exceed this
  /** Press feedback is opacity, not scale — editorial surfaces do not squish. */
  pressOpacity: 0.55,
  /** Live-dot pulse loop duration. */
  pulse: 1200,
  /** Streaming-cursor blink. */
  blink: 600,
  /** @deprecated Scale-transform presses are banned; pinned to 1 so legacy
   * animations still run but no longer move anything. Use `pressOpacity`. */
  pressScale: 1,
  /** @deprecated Springs are retired (ease-out only). Kept, values unchanged,
   * so unmigrated call sites compile; new code uses timing + the durations. */
  spring: Object.freeze({ damping: 18, stiffness: 240, mass: 0.6 }),
});

/** @deprecated The design is flat; kept only so unmigrated screens compile. */
export interface Elevation {
  readonly shadowColor: string;
  readonly shadowOffset: { readonly width: number; readonly height: number };
  readonly shadowOpacity: number;
  readonly shadowRadius: number;
  readonly elevation: number;
}

/** @deprecated See {@link Elevation}. */
export interface ElevationScale {
  readonly none: Elevation;
  readonly sm: Elevation;
  readonly md: Elevation;
  readonly lg: Elevation;
}

// Every step renders no shadow at all: the Ledger system is flat, but deleting
// `theme.elevation` outright would crash the screens that still spread it.
// They keep compiling and silently go flat instead, which is the intent.
const NO_SHADOW: Elevation = Object.freeze({
  shadowColor: 'transparent',
  shadowOffset: Object.freeze({ width: 0, height: 0 }),
  shadowOpacity: 0,
  shadowRadius: 0,
  elevation: 0,
});

const FLAT_ELEVATION: ElevationScale = Object.freeze({
  none: NO_SHADOW,
  sm: NO_SHADOW,
  md: NO_SHADOW,
  lg: NO_SHADOW,
});

export interface Theme {
  readonly scheme: ColorScheme;
  readonly isDark: boolean;
  readonly colors: Palette;
  readonly radius: typeof radius;
  readonly space: typeof space;
  readonly font: typeof font;
  readonly type: typeof type;
  readonly layout: typeof layout;
  readonly motion: typeof motion;
  /** @deprecated Always the zero-shadow scale. Delete after screens migrate. */
  readonly elevation: ElevationScale;
}

const buildTheme = (scheme: ColorScheme, colors: Palette): Theme =>
  Object.freeze({
    scheme,
    isDark: scheme === 'dark',
    colors,
    radius,
    space,
    font,
    type,
    layout,
    motion,
    elevation: FLAT_ELEVATION,
  });

export const darkTheme: Theme = buildTheme('dark', darkPalette);
export const lightTheme: Theme = buildTheme('light', lightPalette);

/** Pure lookup — safe to call outside React (e.g. in StyleSheet factories). */
export function getTheme(scheme: ColorScheme): Theme {
  return scheme === 'light' ? lightTheme : darkTheme;
}

// --- Theme mode store -------------------------------------------------------
// A module-level store rather than a React context, so `useTheme()` works in any
// component without requiring a provider to be mounted at the app root (the
// root layout is owned by another part of the app and may not wrap us).

const MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

// Follow the OS by default, which is only safe because every screen now reads
// the theme through `useTheme()` rather than the static dark palette. app.json
// asks for `userInterfaceStyle: "automatic"` to match; pinning it to dark there
// would report a dark scheme on native no matter what this says. The user can
// still override to light or dark, and that choice is persisted.
const DEFAULT_MODE: ThemeMode = 'system';

let currentMode: ThemeMode = DEFAULT_MODE;
const listeners = new Set<() => void>();

const notify = (): void => {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A misbehaving subscriber must never stop the others from updating.
    }
  });
};

const subscribeMode = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function getThemeMode(): ThemeMode {
  return currentMode;
}

/**
 * Override the OS colour scheme. Unknown values are rejected rather than
 * silently applied, since this is a public boundary.
 */
export function setThemeMode(mode: ThemeMode): void {
  if (!MODES.includes(mode)) {
    throw new Error(`setThemeMode: expected one of ${MODES.join(', ')}, received "${String(mode)}"`);
  }
  if (mode === currentMode) return;
  currentMode = mode;
  notify();
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeMode, getThemeMode, getThemeMode);
}

// Appearance is not guaranteed to be functional on every platform/runtime
// (react-native-web in particular), so both reads are defensive: an unavailable
// API resolves to the dark default rather than throwing during render.
const readSystemScheme = (): ColorScheme => {
  try {
    return Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};

const subscribeSystem = (listener: () => void): (() => void) => {
  try {
    const sub = Appearance.addChangeListener(() => listener());
    return () => sub?.remove?.();
  } catch {
    return () => undefined;
  }
};

/** The OS colour scheme, defaulting to dark when unknown (Deskhandler is dark-first). */
export function useSystemScheme(): ColorScheme {
  return useSyncExternalStore(subscribeSystem, readSystemScheme, readSystemScheme);
}

/** The scheme actually in effect: the override if set, otherwise the OS. */
export function useColorScheme(): ColorScheme {
  const mode = useThemeMode();
  const system = useSystemScheme();
  return mode === 'system' ? system : mode;
}

/** Primary entry point: the resolved theme for the current scheme. */
export function useTheme(): Theme {
  return getTheme(useColorScheme());
}

/** Cycles system -> light -> dark -> system. Handy for a settings row. */
export function useThemeToggle(): () => void {
  const mode = useThemeMode();
  return useCallback(() => {
    const next: ThemeMode = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
    setThemeMode(next);
  }, [mode]);
}

/**
 * Legacy export. Resolves to the dark palette so pre-existing screens that read
 * `colors.bg` at module scope keep working unchanged.
 */
export const colors = darkPalette;
