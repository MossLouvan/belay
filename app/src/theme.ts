// Design tokens for Belay — the "Ledger" system (docs/DESIGN.md).
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
import { Appearance, Easing, Platform, StyleSheet } from 'react-native';
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
  /** The raised sheet/modal slab — one perceptible step off `bg` so a modal
   *  reads as material, not the page folding over itself. */
  readonly sheet: string;
  /** THE ROPE AT REST. Neutral granite track under interactive labels/keys —
   *  replaces `accentDim` in that role so the dock isn't an orange wall.
   *  Loaded (selected/armed/pressed) tracks use `accentGraphic`. */
  readonly trackRest: string;
  /** Solid primary-button fill while pressed — fills darken under load. */
  readonly accentPress: string;
  /** Hairlines ON the machine glass (HUD separators, terminal gutter); paper
   *  `border` never touches the dark surface. */
  readonly machineLine: string;
  /** Topographic garnish ink — decorative only, never carries meaning, always
   *  hidden from accessibility. */
  readonly contour: string;
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
  bg: '#F6F8FB',            // clean off-white page
  surface: '#FFFFFF',        // CARDS + inputs (bordered)
  surfaceAlt: '#EEF1F6',     // recessed rows/keys/pressed
  border: '#E2E6ED',         // the card hairline border (signature clean-card look)
  borderStrong: '#C2C9D6',
  text: '#0F1728',
  textDim: '#5A6473',
  textFaint: '#8A93A3',
  accent: '#1D6FE0',         // electric blue, text-safe on light
  accentGraphic: '#2E7CF6',  // marks / fills / charts
  accentDim: 'rgba(29, 111, 224, 0.28)',
  sheet: '#FFFFFF',
  trackRest: '#D3D9E2',      // muted resting track
  accentPress: '#155ABF',
  machineLine: 'rgba(230, 234, 242, 0.10)',
  contour: 'rgba(15, 23, 40, 0.04)',
  good: '#0B7A55',
  warn: '#8A5A00',
  bad: '#C4342E',
  black: '#06080D',
  machine: '#06080D',        // terminal/stream glass stays deep-dark in both themes
  onMachine: '#E6EAF2',
  onMachineDim: '#8B95A7',
  onAccent: '#FFFFFF',
  onDanger: '#FFFFFF',
  accentSoft: 'rgba(46, 124, 246, 0.10)',  // active-row / selected fill
  goodSoft: 'rgba(11, 122, 85, 0.10)',
  warnSoft: 'rgba(138, 90, 0, 0.10)',
  badSoft: 'rgba(196, 52, 46, 0.10)',
  onAccentSoft: '#1A63C9',
  onGoodSoft: '#0A6B4A',
  onWarnSoft: '#7A5000',
  onBadSoft: '#B12F29',
  overlay: 'rgba(15, 23, 40, 0.40)',
  focus: '#1D6FE0',
  skeleton: '#E8EBF0',
  shadow: '#000000',
});

/** Dark — "ink". Warm near-black, not blue-black; the accent survives untamed. */
export const darkPalette: Palette = Object.freeze({
  bg: '#0B0E14',            // deep navy-black page ground (the reference)
  surface: '#11151E',        // CARDS + inputs, subtly lifted off the ground
  surfaceAlt: '#171C27',     // recessed rows/keys/pressed
  border: '#1E2632',         // the clean card hairline border (signature)
  borderStrong: '#2C3546',
  text: '#E6EAF2',           // near-white
  textDim: '#8B95A7',        // muted blue-grey labels (reference "Client IP")
  textFaint: '#5E6675',
  accent: '#3B82F6',         // electric blue, text-safe on navy
  accentGraphic: '#2E7CF6',  // marks / fills / charts
  accentDim: 'rgba(59, 130, 246, 0.30)',
  sheet: '#141A24',
  trackRest: '#2A3340',      // muted resting track
  accentPress: '#2563EB',
  machineLine: 'rgba(230, 234, 242, 0.08)',
  contour: 'rgba(230, 234, 242, 0.05)',
  good: '#3DDC97',
  warn: '#F7B32B',
  bad: '#FF6B6B',
  black: '#06080D',
  machine: '#06080D',        // terminal/stream glass — deeper than the page
  onMachine: '#E6EAF2',
  onMachineDim: '#8B95A7',
  onAccent: '#FFFFFF',       // white on blue
  onDanger: '#FFFFFF',
  accentSoft: 'rgba(46, 124, 246, 0.16)',  // active-row / selected fill
  goodSoft: 'rgba(61, 220, 151, 0.14)',
  warnSoft: 'rgba(247, 179, 43, 0.14)',
  badSoft: 'rgba(255, 107, 107, 0.14)',
  onAccentSoft: '#7FB0FF',
  onGoodSoft: '#3DDC97',
  onWarnSoft: '#F7B32B',
  onBadSoft: '#FF6B6B',
  overlay: 'rgba(0, 0, 0, 0.65)',
  focus: '#3B82F6',
  skeleton: '#171C27',
  shadow: '#000000',
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
  /** Card radius — revived for the reference's bordered navy cards. */
  lg: 10,
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
  label: { fontFamily: font.mono, fontSize: 11, lineHeight: 14, fontWeight: '400', letterSpacing: 1.5, textTransform: 'uppercase', fontVariant: ['tabular-nums'] },
  micro: { fontFamily: font.mono, fontSize: 10, lineHeight: 13, fontWeight: '400', letterSpacing: 1.2, textTransform: 'uppercase', fontVariant: ['tabular-nums'] },
  mono: { fontFamily: font.mono, fontSize: 13, lineHeight: 19, fontVariant: ['tabular-nums'] },
  monoSmall: { fontFamily: font.mono, fontSize: 11, lineHeight: 16, fontVariant: ['tabular-nums'] },
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
  /** The one sanctioned hero animation: the clip-in rope draw on connect. */
  draw: 400,
  /** @deprecated Pulsing is banned (founder directive). Pinned to 0 so
   *  `usePulse` degrades to a steady value — status is shape (ring→fill) +
   *  colour, never a blink. */
  pulse: 0,
  /** @deprecated Blinking is banned. The streaming cursor is a steady block. */
  blink: 0,
  /** @deprecated Scale-transform presses are banned; pinned to 1 so legacy
   * animations still run but no longer move anything. Use `pressOpacity`. */
  pressScale: 1,
  /** @deprecated Springs are retired (ease-out only). Kept, values unchanged,
   * so unmigrated call sites compile; new code uses timing + the durations. */
  spring: Object.freeze({ damping: 18, stiffness: 240, mass: 0.6 }),
});

/** The two curves the whole app moves on. Entrances/fades/slides use
 *  `standard`; exits (sheet down, HUD hide) use `exit`; clocks/progress use
 *  `linear`. One easing vocabulary keeps motion feeling like one product. */
export const easing = Object.freeze({
  standard: Easing.bezier(0.2, 0, 0, 1),
  exit: Easing.bezier(0.3, 0, 0.8, 0.15),
  linear: Easing.linear,
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

/** The OS colour scheme, defaulting to dark when unknown (Belay is dark-first). */
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

/**
 * Legacy export. Resolves to the dark palette so pre-existing screens that read
 * `colors.bg` at module scope keep working unchanged.
 */
export const colors = darkPalette;
