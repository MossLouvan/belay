// Design tokens for Tether.
//
// Two hand-tuned palettes (dark + light), a type scale, elevation, motion and
// layout constants. Plain objects and one tiny external store — no theming
// library, so the web bundle stays small and Expo Go stays happy.
//
// Backwards compatibility: the legacy named exports `colors`, `radius`, `space`
// and `font` still exist and `colors` still resolves to the dark palette, so
// screens written against the old API keep compiling. New code should call
// `useTheme()` and read `theme.colors` instead.

import { useCallback, useSyncExternalStore } from 'react';
import { Appearance, Platform, TextStyle } from 'react-native';

export type ColorScheme = 'light' | 'dark';
export type ThemeMode = 'system' | ColorScheme;

/**
 * Every colour role available to a screen. The first block is the legacy set
 * (kept byte-for-byte compatible in name and meaning); the second block adds
 * semantic roles introduced with the light theme.
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
  readonly accentDim: string;
  readonly good: string;
  readonly warn: string;
  readonly bad: string;
  readonly black: string;
  // Semantic roles.
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
  readonly shadow: string;
}

// Contrast verified with a WCAG 2.1 relative-luminance check against bg,
// surface and surfaceAlt. Worst-case ratios are noted per colour.
export const darkPalette: Palette = Object.freeze({
  bg: '#0A0C11',
  surface: '#141824',
  surfaceAlt: '#1C2230',
  border: '#262D3D',
  borderStrong: '#3A4356',
  text: '#F3F6FC', // >= 14.69:1
  textDim: '#A6B1C6', // >= 7.36:1
  textFaint: '#828EA5', // >= 4.82:1
  accent: '#7C8CFF', // >= 5.34:1
  accentDim: '#2E3A6E',
  good: '#3DDC97', // >= 9.00:1
  warn: '#F7B32B', // >= 8.66:1
  bad: '#FF6B6B', // >= 5.73:1
  black: '#05070A',
  onAccent: '#05070A', // 6.77:1 on accent
  onDanger: '#05070A', // 7.27:1 on bad
  // Translucent fills. Ratios below are for the on-fill text composited over
  // the fill composited over the *worst* backdrop of { bg, surface, surfaceAlt }
  // — which for the dark palette is always surfaceAlt, the lightest of the
  // three (a badge sitting on a raised Card). Re-run the composited check
  // before touching either the alpha or the on* colour; contrast against the
  // raw fill colour is meaningless here.
  accentSoft: 'rgba(124, 140, 255, 0.16)',
  goodSoft: 'rgba(61, 220, 151, 0.16)',
  warnSoft: 'rgba(247, 179, 43, 0.16)',
  badSoft: 'rgba(255, 107, 107, 0.16)',
  onAccentSoft: '#8C9AFF', // >= 4.82:1 on accentSoft over surfaceAlt
  onGoodSoft: '#3DDC97', // >= 6.36:1 on goodSoft over surfaceAlt
  onWarnSoft: '#F7B32B', // >= 6.21:1 on warnSoft over surfaceAlt
  onBadSoft: '#FF7A7A', // >= 4.99:1 on badSoft over surfaceAlt
  overlay: 'rgba(3, 5, 9, 0.72)',
  focus: '#7C8CFF',
  skeleton: '#222939',
  shadow: '#000000',
});

export const lightPalette: Palette = Object.freeze({
  bg: '#F4F6FA',
  surface: '#FFFFFF',
  surfaceAlt: '#EAEEF6',
  border: '#DCE2EC',
  borderStrong: '#B9C2D2',
  text: '#0D1017', // >= 16.36:1
  textDim: '#4E5768', // >= 6.26:1
  textFaint: '#5D6780', // >= 4.86:1
  accent: '#3B4CD8', // >= 5.62:1
  accentDim: '#C9D0F7',
  good: '#0B7A54', // >= 4.60:1
  warn: '#8A5A05', // >= 5.09:1
  bad: '#C62B39', // >= 4.75:1
  black: '#05070A',
  onAccent: '#FFFFFF', // 6.54:1 on accent
  onDanger: '#FFFFFF', // 5.52:1 on bad
  // Same rule as the dark palette: ratios are for the on-fill text composited
  // over the fill composited over the worst backdrop of { bg, surface,
  // surfaceAlt }. For the light palette the worst case is surfaceAlt (the
  // darkest of the three), with bg a close second. The solid `good`/`warn`/
  // `bad` colours all fall under 4.5:1 once the fill is composited, which is
  // why these darker on* variants exist.
  accentSoft: 'rgba(59, 76, 216, 0.12)',
  goodSoft: 'rgba(11, 122, 84, 0.12)',
  warnSoft: 'rgba(138, 90, 5, 0.12)',
  badSoft: 'rgba(198, 43, 57, 0.12)',
  onAccentSoft: '#3644CC', // >= 5.32:1 on accentSoft over surfaceAlt
  onGoodSoft: '#0A6B4A', // >= 4.80:1 on goodSoft over surfaceAlt
  onWarnSoft: '#7E5205', // >= 4.94:1 on warnSoft over surfaceAlt
  onBadSoft: '#AE2632', // >= 4.80:1 on badSoft over surfaceAlt
  overlay: 'rgba(13, 16, 23, 0.45)',
  focus: '#3B4CD8',
  skeleton: '#E2E7F0',
  shadow: '#1C2536',
});

export const radius = Object.freeze({
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  xl: 26,
  pill: 999,
});

export const space = Object.freeze({
  none: 0,
  xxs: 2,
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 34,
  xxl: 48,
});

export const font = Object.freeze({
  mono: Platform.select({
    ios: 'Menlo',
    default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }) as string,
});

/** Type scale. Every entry is a ready-to-spread `TextStyle`. */
export const type = Object.freeze({
  display: { fontSize: 32, lineHeight: 38, fontWeight: '800', letterSpacing: -0.6 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '800', letterSpacing: -0.3 },
  heading: { fontSize: 21, lineHeight: 27, fontWeight: '700', letterSpacing: -0.2 },
  subheading: { fontSize: 17, lineHeight: 23, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '500' },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '700' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  mono: { fontFamily: font.mono, fontSize: 13, lineHeight: 19 },
  monoSmall: { fontFamily: font.mono, fontSize: 11, lineHeight: 16 },
}) satisfies Readonly<Record<string, TextStyle>>;

export type TypeVariant = keyof typeof type;

/** Layout constants. 44pt is the Apple/WCAG minimum touch target. */
export const layout = Object.freeze({
  minTouch: 44,
  hairline: 1,
  tabBarHeight: 58,
  contentMaxWidth: 760,
  hitSlop: Object.freeze({ top: 8, bottom: 8, left: 8, right: 8 }),
});

/** Animation timings, in ms. Screens must gate these on `useReducedMotion()`. */
export const motion = Object.freeze({
  instant: 0,
  fast: 120,
  base: 180,
  slow: 280,
  pressScale: 0.97,
  spring: Object.freeze({ damping: 18, stiffness: 240, mass: 0.6 }),
});

export interface Elevation {
  readonly shadowColor: string;
  readonly shadowOffset: { readonly width: number; readonly height: number };
  readonly shadowOpacity: number;
  readonly shadowRadius: number;
  readonly elevation: number;
}

export interface ElevationScale {
  readonly none: Elevation;
  readonly sm: Elevation;
  readonly md: Elevation;
  readonly lg: Elevation;
}

const makeElevation = (scheme: ColorScheme, shadowColor: string): ElevationScale => {
  // Dark UIs need denser shadows to read at all against a near-black canvas.
  const k = scheme === 'dark' ? 1.9 : 1;
  const shadow = (height: number, opacity: number, blur: number, depth: number): Elevation =>
    Object.freeze({
      shadowColor,
      shadowOffset: Object.freeze({ width: 0, height }),
      shadowOpacity: Math.min(0.6, opacity * k),
      shadowRadius: blur,
      elevation: depth,
    });
  return Object.freeze({
    none: shadow(0, 0, 0, 0),
    sm: shadow(1, 0.06, 3, 1),
    md: shadow(4, 0.1, 12, 4),
    lg: shadow(12, 0.14, 28, 12),
  });
};

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
    elevation: makeElevation(scheme, colors.shadow),
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

// Dark-first on purpose. app.json pins `userInterfaceStyle: "dark"`, and the
// screens that have not yet been migrated to `useTheme()` still paint hardcoded
// dark backgrounds — following the OS before they are migrated would render
// light-theme text on those dark surfaces. Flip this to 'system' (or call
// `setThemeMode('system')` at the app root) once every screen reads the theme.
const DEFAULT_MODE: ThemeMode = 'dark';

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

/** The OS colour scheme, defaulting to dark when unknown (Tether is dark-first). */
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
