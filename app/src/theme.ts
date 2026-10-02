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
import { appearanceFor } from './design/look';
import type { LookName } from './design/look';

export type ColorScheme = 'light' | 'dark';
export type ThemeMode = 'system' | ColorScheme | 'current' | 'fieldwork' | 'harbour' | 'harbour-night';

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
  // Welcome-hero roles — the beluga's water. Introduced for the first-run
  // welcome screen so the mascot (soft white beluga, blue water) and the
  // blue-rope brand share one palette instead of the mascot floating on the
  // neutral page.
  /** The hero page ground: `bg` nudged toward ocean blue-black (dark) / ice
   *  blue (light). Carries `text`/`textDim` — verified against both. */
  readonly heroBg: string;
  /** Translucent blue wash for the halo behind the mascot. Decorative only —
   *  never carries meaning, always hidden from accessibility. */
  readonly heroGlow: string;
  /** @deprecated Dead with elevation — the design is flat. Kept so unmigrated
   * screens compile; remove with the `elevation` shim. */
  readonly shadow: string;
  // Harbour roles (gobelay.com). Flat looks set them so nothing changes:
  // the CTA ends equal `accent`, the swash is transparent, depth is 'none'.
  /** The primary button's fill, painted top to bottom (Harbour: lantern amber). */
  readonly ctaTop: string;
  readonly ctaBottom: string;
  /** Label/icon ink on the primary fill. */
  readonly onCta: string;
  /** The soft highlighter band painted under a hero heading's key word. */
  readonly swash: string;
  /** A CSS box-shadow for raised surfaces (cards, cloud pills), or 'none'. */
  readonly depth: string;
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
  heroBg: '#EDF3FB',        // ice-blue page — daylight over the water
  heroGlow: 'rgba(46, 124, 246, 0.10)',
  shadow: '#000000',
  ctaTop: '#1D6FE0', ctaBottom: '#1D6FE0', onCta: '#FFFFFF', swash: 'transparent', depth: 'none',
});

/** Dark — "ink". Premium near-black with soft glass surfaces and restrained accent. */
export const darkPalette: Palette = Object.freeze({
  bg: '#0A0A0C',            // premium near-black canvas, neutral (not blue-tinted)
  surface: '#141418',        // soft glass panels, minimal lift for premium feel
  surfaceAlt: '#1A1A1E',     // recessed rows/keys/pressed — subtle depth
  border: '#1F1F23',         // hairline borders — whisper-quiet, glass-like
  borderStrong: '#2A2A30',   // emphasis borders — still restrained
  text: '#F5F5F7',           // crisp white, high contrast for readability
  textDim: '#9B9BA3',        // muted secondary text, neutral grey
  textFaint: '#67676E',      // tertiary text, quiet but legible
  accent: '#3B82F6',         // electric blue — the one chromatic accent (restrained)
  accentGraphic: '#5B9CF8',  // lighter blue for marks/graphics
  accentDim: 'rgba(59, 130, 246, 0.25)',  // muted accent track
  sheet: '#101014',          // modals/sheets — one step darker than bg for depth
  trackRest: '#2E2E34',      // neutral resting track (not accent-tinted)
  accentPress: '#2563EB',    // darker blue for pressed state
  machineLine: 'rgba(255, 255, 255, 0.06)',  // ultra-subtle machine panel rules
  contour: 'rgba(255, 255, 255, 0.03)',      // barely-there topographic garnish
  good: '#3DDC97',           // success green — kept from original
  warn: '#F7B32B',           // warning amber
  bad: '#FF6B6B',            // error red
  black: '#000000',          // true black for machine glass
  machine: '#000000',        // terminal/video — true black, not lifted
  onMachine: '#F5F5F7',      // white on machine glass
  onMachineDim: '#9B9BA3',   // muted on machine
  onAccent: '#FFFFFF',       // white on blue
  onDanger: '#FFFFFF',       // white on red
  accentSoft: 'rgba(59, 130, 246, 0.12)',    // soft accent fill — more subtle
  goodSoft: 'rgba(61, 220, 151, 0.12)',
  warnSoft: 'rgba(247, 179, 43, 0.12)',
  badSoft: 'rgba(255, 107, 107, 0.12)',
  onAccentSoft: '#7FB0FF',   // text on soft accent
  onGoodSoft: '#3DDC97',
  onWarnSoft: '#F7B32B',
  onBadSoft: '#FF6B6B',
  overlay: 'rgba(0, 0, 0, 0.75)',  // deeper overlay for modals
  focus: '#3B82F6',
  skeleton: '#1A1A1E',
  heroBg: '#0A0E16',        // ocean blue-black — bg tilted toward the water
  heroGlow: 'rgba(91, 156, 248, 0.14)',
  shadow: '#000000',
  ctaTop: '#3B82F6', ctaBottom: '#3B82F6', onCta: '#FFFFFF', swash: 'transparent', depth: 'none',
});

/**
 * Rounded, calm chrome inspired by premium SaaS UIs. More generous than the
 * original system but still restrained — no extreme rounding.
 */
export const radius = Object.freeze({
  xs: 10,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 16, // hero elements when needed
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
  // Outfit from Google Fonts as the primary UI typeface. Loaded in app/_layout.tsx
  // with weights 400 (Regular), 500 (Medium), 600 (SemiBold), and 700 (Bold).
  // The font is specified by weight via the type scale below.
  sans: Platform.select({ ios: 'System', default: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }) as string,
  /** Headings. The flat looks set them in the UI face; Harbour swaps in Fredoka. */
  display: Platform.select({ ios: 'System', default: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }) as string,
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
  display: { fontFamily: font.sans, fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.9 },
  title: { fontFamily: font.sans, fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.5 },
  heading: { fontFamily: font.sans, fontSize: 19, lineHeight: 24, fontWeight: '800', letterSpacing: -0.3 },
  subheading: { fontFamily: font.sans, fontSize: 16, lineHeight: 21, fontWeight: '700' },
  body: { fontFamily: font.sans, fontSize: 15, lineHeight: 21, fontWeight: '400' },
  bodyStrong: { fontFamily: font.sans, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  caption: { fontFamily: font.sans, fontSize: 13, lineHeight: 17, fontWeight: '400' },
  // Hero stats ("39%"). Tabular numerals so live values do not jitter.
  numeral: { fontFamily: font.sans, fontSize: 34, lineHeight: 38, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  label: { fontFamily: font.sans, fontSize: 13, lineHeight: 18, fontWeight: '500' },
  micro: { fontFamily: font.sans, fontSize: 11, lineHeight: 15, fontWeight: '400' },
  mono: { fontFamily: font.mono, fontSize: 13, lineHeight: 19, fontVariant: ['tabular-nums'] },
  monoSmall: { fontFamily: font.mono, fontSize: 11, lineHeight: 16, fontVariant: ['tabular-nums'] },
  // Button and segment labels. Separate from `label` on purpose: `label` is
  // the quiet 13pt row/section marker and half the app is set in it, while a
  // button's word has to hold a 44pt slab on its own. Both concept mockups
  // set every button — Connect, Audio on, Trackpad — at this size and weight.
  button: { fontFamily: font.sans, fontSize: 15, lineHeight: 20, fontWeight: '600', letterSpacing: -0.1 },
  // The five-tab bar's word. Never larger: at 12pt the labels start colliding
  // with each other on a 375pt phone.
  tab: { fontFamily: font.sans, fontSize: 11, lineHeight: 14, fontWeight: '500' },
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

const buildTheme = (
  scheme: ColorScheme,
  colors: Palette,
  faces: typeof font = font,
  scale: typeof type = type,
): Theme =>
  Object.freeze({
    scheme,
    isDark: scheme === 'dark',
    colors,
    radius,
    space,
    font: faces,
    type: scale,
    layout,
    motion,
    elevation: FLAT_ELEVATION,
  });

/**
 * Fieldwork — the dark appearance. Every value below is sampled from
 * output/design-concepts-2026-09-11/fieldwork.png rather than invented: the
 * near-black ground (#191B1C), the card one step up (#222426), the recessed
 * pad/pill (#232628) and the warm orange the Connect button is actually
 * painted (#F99657). The muted `accentSoft` (#4A392E) is the selected
 * segment's fill in the same mockup — orange ink on scorched earth, never a
 * solid orange chip.
 */
export const fieldworkPalette: Palette = Object.freeze({ ...darkPalette,
  bg: '#191B1C', surface: '#222426', surfaceAlt: '#232628', sheet: '#1F2123',
  // textFaint ≥ 4.90:1 on every backdrop (#71; was #82878A at 4.19 on surfaceAlt).
  border: '#2C2F31', borderStrong: '#494D50', text: '#F2F2EF', textDim: '#A8ACAF', textFaint: '#8E9396',
  accent: '#F99657', accentGraphic: '#F99657', accentPress: '#E0824A', onAccent: '#1A1210',
  ctaTop: '#F99657', ctaBottom: '#F99657', onCta: '#1A1210',
  // The danger button's ink is the same scorched ink as onAccent: 6.65:1 on
  // `bad`, where the inherited white was 2.78 (#71).
  onDanger: '#1A1210',
  accentDim: '#4A392E', accentSoft: '#4A392E', onAccentSoft: '#F9A96F', focus: '#F99657',
  heroBg: '#191B1C', heroGlow: 'transparent', trackRest: '#3A3E41',
  machine: '#101112', skeleton: '#202325',
});

/**
 * Current — the light appearance, sampled the same way from current.png: the
 * cool off-white page (#F5F8FC), near-white cards (#FCFDFE), one recessed
 * step (#EAEFF4) that does triple duty as the trackpad, the segment track and
 * the round header button, and the blue the Connect button is painted.
 */
export const currentPalette: Palette = Object.freeze({ ...lightPalette,
  bg: '#F5F8FC', surface: '#FCFDFE', surfaceAlt: '#EAEFF4', sheet: '#FFFFFF',
  // textFaint ≥ 4.54:1 on every backdrop (#71; was #8791A1 at 2.75 on surfaceAlt).
  text: '#101828', textDim: '#5B6676', textFaint: '#616D7E', border: '#E4E9F0', borderStrong: '#C7CEDA',
  accent: '#245CCC', accentGraphic: '#245CCC', accentPress: '#1B49A5',
  ctaTop: '#245CCC', ctaBottom: '#245CCC',
  accentSoft: '#E4ECFB', onAccentSoft: '#1F52B8', focus: '#245CCC',
  heroBg: '#F5F8FC', heroGlow: 'transparent', trackRest: '#D5DCE6',
  skeleton: '#EAEFF4',
});

/**
 * Harbour — gobelay.com's palette (belay-site globals.css `[data-harbour]`):
 * a misty warm sky for the page, lamplit cream cards, deep slate-navy ink,
 * lagoon for links and marks, and the lantern-amber gradient on the one
 * primary action. Selected chips warm to lamplight (`accentSoft`) as the
 * site's glass does. Every text pair is AA on bg/surface/surfaceAlt
 * (theme-contrast.test.mjs).
 */
export const harbourPalette: Palette = Object.freeze({ ...lightPalette,
  bg: '#ECE9E3', surface: '#FDF8EF', surfaceAlt: '#E2E7E2', sheet: '#FDF8EF',
  border: '#D5D9D2', borderStrong: '#A7B5B4',
  text: '#1E3A4C', textDim: '#3A5666', textFaint: '#4F6977',
  accent: '#0C6069', accentGraphic: '#2B8C82', accentPress: '#094E56', onAccent: '#FDF8EF',
  accentDim: 'rgba(43, 140, 130, 0.28)', trackRest: '#CDD4CE',
  accentSoft: '#FFF3DC', onAccentSoft: '#7A4E0E',
  good: '#0A6E4C', warn: '#8A5A00', bad: '#B03A2A', onDanger: '#FFFFFF',
  goodSoft: 'rgba(10, 110, 76, 0.10)', warnSoft: 'rgba(138, 90, 0, 0.10)', badSoft: 'rgba(176, 58, 42, 0.10)',
  onGoodSoft: '#085C3F', onWarnSoft: '#6E4700', onBadSoft: '#94301F',
  machine: '#0B171D', black: '#0B171D', onMachine: '#E9EFEE', onMachineDim: '#8FA3AB',
  contour: 'rgba(30, 58, 76, 0.05)', overlay: 'rgba(30, 58, 76, 0.40)',
  focus: '#163743', skeleton: '#E2E7E2',
  heroBg: '#E9ECE6', heroGlow: 'rgba(196, 236, 226, 0.95)', shadow: '#2F4A52',
  ctaTop: '#FFE2A8', ctaBottom: '#FFBF66', onCta: '#1A3A45',
  swash: '#FFD99A',
  // Shadows belong to the sea, never black (site: --color-sea-shadow).
  depth: '0px 10px 24px -14px rgba(47, 74, 82, 0.38), 0px 1px 2px rgba(47, 74, 82, 0.08)',
});

/** Harbour at night: the same harbour under a deep sea-slate sky, the lantern still lit. */
export const harbourNightPalette: Palette = Object.freeze({ ...darkPalette,
  bg: '#0E1C24', surface: '#15272F', surfaceAlt: '#1B3039', sheet: '#132530',
  border: '#22383F', borderStrong: '#3A5560',
  text: '#EEF2EF', textDim: '#B4C5C8', textFaint: '#8DA3A9',
  accent: '#7FD6CA', accentGraphic: '#56C2B6', accentPress: '#5FC3B6', onAccent: '#0E1C24',
  accentDim: 'rgba(86, 194, 182, 0.25)', trackRest: '#2C434C',
  accentSoft: '#3A3222', onAccentSoft: '#FFCB7E',
  good: '#4FD39B', warn: '#F2B84B', bad: '#FF8A75', onDanger: '#1A1210',
  goodSoft: 'rgba(79, 211, 155, 0.12)', warnSoft: 'rgba(242, 184, 75, 0.12)', badSoft: 'rgba(255, 138, 117, 0.12)',
  onGoodSoft: '#4FD39B', onWarnSoft: '#F2B84B', onBadSoft: '#FF8A75',
  machine: '#071117', black: '#071117', onMachine: '#EEF2EF', onMachineDim: '#8DA3A9',
  overlay: 'rgba(4, 12, 16, 0.72)', focus: '#7FD6CA', skeleton: '#1B3039',
  heroBg: '#0F2029', heroGlow: 'rgba(86, 194, 182, 0.16)', shadow: '#000000',
  ctaTop: '#FFD68F', ctaBottom: '#F5B354', onCta: '#1A3A45',
  swash: 'rgba(255, 203, 126, 0.30)',
  depth: '0px 12px 28px -16px rgba(0, 0, 0, 0.7), inset 0px 1px 0px rgba(255, 255, 255, 0.05)',
});

/** Harbour's voice: Fredoka (rounded display) for headings and the pill's
 *  word, Nunito for text — the site's two faces, both OFL, loaded by
 *  app/_layout.tsx. One registered family per weight, so weights here are
 *  'normal': a numeric weight on top would make web synthesise a second bold. */
const FREDOKA = 'Fredoka_600SemiBold';
const NUNITO = 'Nunito_500Medium';
const NUNITO_BOLD = 'Nunito_700Bold';
const NUNITO_SEMI = 'Nunito_600SemiBold';

export const harbourFont: typeof font = Object.freeze({ ...font, sans: NUNITO, display: FREDOKA });

const face = (fontFamily: string) => ({ fontFamily, fontWeight: 'normal' as const });
export const harbourType: typeof type = Object.freeze({
  display: { ...type.display, ...face(FREDOKA), letterSpacing: -0.3 },
  title: { ...type.title, ...face(FREDOKA), letterSpacing: -0.2 },
  heading: { ...type.heading, ...face(FREDOKA), letterSpacing: 0 },
  subheading: { ...type.subheading, ...face(FREDOKA) },
  body: { ...type.body, ...face(NUNITO) },
  bodyStrong: { ...type.bodyStrong, ...face(NUNITO_BOLD) },
  caption: { ...type.caption, ...face(NUNITO) },
  numeral: { ...type.numeral, ...face(FREDOKA), letterSpacing: 0 },
  label: { ...type.label, ...face(NUNITO_SEMI) },
  micro: { ...type.micro, ...face(NUNITO) },
  mono: type.mono,
  monoSmall: type.monoSmall,
  button: { ...type.button, ...face(FREDOKA), fontSize: 16, letterSpacing: 0 },
  tab: { ...type.tab, ...face(NUNITO_SEMI) },
  // Same shape as `type`; only the literal fontWeight types differ.
}) as unknown as typeof type;

export const darkTheme: Theme = buildTheme('dark', fieldworkPalette);
export const lightTheme: Theme = buildTheme('light', currentPalette);
export const harbourTheme: Theme = buildTheme('light', harbourPalette, harbourFont, harbourType);
export const harbourNightTheme: Theme = buildTheme('dark', harbourNightPalette, harbourFont, harbourType);

const THEMES: Readonly<Record<LookName, Readonly<Record<ColorScheme, Theme>>>> = Object.freeze({
  harbour: Object.freeze({ light: harbourTheme, dark: harbourNightTheme }),
  current: Object.freeze({ light: lightTheme, dark: darkTheme }),
  fieldwork: Object.freeze({ light: lightTheme, dark: darkTheme }),
});

/**
 * Pure lookup — safe to call outside React (e.g. in StyleSheet factories).
 * Resolves within the active look, so the machine HUD's `getTheme('dark')`
 * is Harbour at night under Harbour and Fieldwork under the flat looks.
 */
export function getTheme(scheme: ColorScheme): Theme {
  return THEMES[appearanceFor(currentMode, readSystemScheme()).look][scheme];
}

// --- Theme mode store -------------------------------------------------------
// A module-level store rather than a React context, so `useTheme()` works in any
// component without requiring a provider to be mounted at the app root (the
// root layout is owned by another part of the app and may not wrap us).

export const MODES: readonly ThemeMode[] = ['system', 'light', 'dark', 'current', 'fieldwork', 'harbour', 'harbour-night'];

// Follow the OS by default, which is only safe because every screen now reads
// the theme through `useTheme()` rather than the static dark palette. app.json
// asks for `userInterfaceStyle: "automatic"` to match; pinning it to dark there
// would report a dark scheme on native no matter what this says. The user can
// still override to light or dark, and that choice is persisted.
const DEFAULT_MODE: ThemeMode = 'harbour';

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
// Belay is DARK-FIRST: the product identity is the deep-navy Next Terminal
// look, so the app commits to dark rather than following the phone's light
// setting. The full light palette is retained (lightPalette) for a future
// in-app theme toggle — flip DARK_FIRST to restore system-follow.
const DARK_FIRST = true;
const readSystemScheme = (): ColorScheme => {
  if (DARK_FIRST) return 'dark';
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
  return useAppearance().scheme;
}

/** The look and scheme in effect (design/look.ts `appearanceFor`). */
export function useAppearance(): { readonly look: LookName; readonly scheme: ColorScheme } {
  return appearanceFor(useThemeMode(), useSystemScheme());
}

/** Primary entry point: the resolved theme for the current look and scheme. */
export function useTheme(): Theme {
  const { look, scheme } = useAppearance();
  return THEMES[look][scheme];
}

/**
 * Legacy export. Resolves to the dark palette so pre-existing screens that read
 * `colors.bg` at module scope keep working unchanged.
 */
export const colors = darkPalette;
