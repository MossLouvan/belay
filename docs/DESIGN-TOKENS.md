# Deskhandler Design Tokens — "Ledger"

Concrete values for `app/src/theme.ts`, mapped onto the existing token names so the
migration is mechanical wherever possible. Read [DESIGN.md](./DESIGN.md) first for the
rules these values serve. Everything here is transcription-ready.

Contrast note: every ratio below was computed with a WCAG 2.1 relative-luminance check
(the same method as the current theme's comments) against the worst case of
{ bg, surface, surfaceAlt }; `on*Soft` ratios are against the soft fill composited over
`surfaceAlt`. The throwaway verifier script lives at the bottom of this file — re-run it
if any hex or alpha changes.

---

## 1. Palette

`Palette` interface changes:

- **Add:** `accentGraphic`, `machine`, `onMachine`, `onMachineDim`.
- **Repurpose (meaning changes):** `black` → becomes the machine-panel colour on both
  themes (alias of `machine`; keep the name for compatibility, new code uses `machine`).
  `accentDim` → was "muted accent fill"; now the *disabled/track* tint of the accent
  (used only for the segmented-underline track and disabled primary buttons).
- **Unchanged meaning:** everything else keeps its role; only values change.

### 1.1 `lightPalette` ("paper")

```ts
export const lightPalette: Palette = Object.freeze({
  bg: '#EAE8E4',
  surface: '#F2F1EE',            // inputs only
  surfaceAlt: '#E1DED9',         // recessed: keys, tracks, pressed rows
  border: '#C8C4BD',             // hairlines (non-text)
  borderStrong: '#8F8A82',       // emphasis rules only where ink 2pt is too loud
  text: '#161513',               // >= 13.60:1
  textDim: '#4F4B45',            // >= 6.45:1
  textFaint: '#615C55',          // >= 4.94:1
  accent: '#B03700',             // >= 4.61:1  (text-safe burnt orange)
  accentGraphic: '#E84A00',      // >= 3.17:1 vs bg — NON-TEXT marks only (WCAG 1.4.11)
  accentDim: 'rgba(176, 55, 0, 0.28)', // tracks/disabled fills, non-text
  good: '#0B6040',               // >= 5.67:1
  warn: '#754C04',               // >= 5.06:1
  bad: '#A82028',                // >= 5.39:1
  black: '#0C0B0A',              // alias of machine (legacy name)
  machine: '#0C0B0A',            // terminal/video panel — dark in BOTH themes
  onMachine: '#ECEAE6',          // 16.37:1 on machine
  onMachineDim: '#A9A49C',       // 7.94:1 on machine
  onAccent: '#FFFFFF',           // 5.9:1 on accent
  onDanger: '#FFFFFF',           // 5.6:1 on bad
  accentSoft: 'rgba(176, 55, 0, 0.10)',
  goodSoft: 'rgba(11, 96, 64, 0.10)',
  warnSoft: 'rgba(117, 76, 4, 0.10)',
  badSoft: 'rgba(168, 32, 40, 0.10)',
  onAccentSoft: '#9A3000',       // >= 4.85:1 composited over surfaceAlt
  onGoodSoft: '#095538',         // >= 5.66:1
  onWarnSoft: '#6D4603',         // >= 5.36:1
  onBadSoft: '#961E25',          // >= 5.33:1
  overlay: 'rgba(22, 21, 19, 0.40)',
  focus: '#B03700',
  skeleton: '#DBD8D2',
  shadow: '#000000',             // dead — elevation is deleted; kept only if the
                                 // Palette type is not pruned in the same pass
});
```

### 1.2 `darkPalette` ("ink")

```ts
export const darkPalette: Palette = Object.freeze({
  bg: '#121110',
  surface: '#1A1917',
  surfaceAlt: '#232120',
  border: '#2E2C29',
  borderStrong: '#4A4741',
  text: '#ECEAE6',               // >= 13.34:1
  textDim: '#A9A49C',            // >= 6.47:1
  textFaint: '#928D84',          // >= 4.86:1
  accent: '#FF5C1A',             // >= 5.19:1
  accentGraphic: '#FF4D00',      // >= 4.82:1 (non-text marks)
  accentDim: 'rgba(255, 92, 26, 0.30)',
  good: '#3DDC97',               // >= 9.07:1  (kept from current palette)
  warn: '#F7B32B',               // >= 8.73:1  (kept)
  bad: '#FF7A70',                // >= 6.31:1  (lifted from #FF6B6B)
  black: '#0C0B0A',
  machine: '#0C0B0A',
  onMachine: '#ECEAE6',          // 16.37:1
  onMachineDim: '#A9A49C',       // 7.94:1
  onAccent: '#121110',           // 6.1:1 on accent
  onDanger: '#121110',           // 6.9:1 on bad
  accentSoft: 'rgba(255, 92, 26, 0.14)',
  goodSoft: 'rgba(61, 220, 151, 0.14)',
  warnSoft: 'rgba(247, 179, 43, 0.14)',
  badSoft: 'rgba(255, 122, 112, 0.14)',
  onAccentSoft: '#FF7A3D',       // >= 5.17:1 composited over surfaceAlt
  onGoodSoft: '#3DDC97',         // >= 6.77:1
  onWarnSoft: '#F7B32B',         // >= 6.51:1
  onBadSoft: '#FF7A70',          // >= 5.13:1
  overlay: 'rgba(0, 0, 0, 0.60)',
  focus: '#FF5C1A',
  skeleton: '#262421',
  shadow: '#000000',             // dead, see light palette note
});
```

---

## 2. Radius

Square corners are the system. Keys keep their names; values collapse.

```ts
export const radius = Object.freeze({
  xs: 2,     // was 4  — standard radius: inputs, buttons, soft-fill bands
  sm: 4,     // was 8  — key-bar keys only
  md: 4,     // was 12 — DEPRECATED alias of sm; migrate call sites to xs/sm, then delete
  lg: 0,     // was 18 — DEPRECATED: card radius; card is dead. Delete after migration.
  xl: 0,     // was 26 — DEPRECATED: delete after migration.
  pill: 999, // DEPRECATED: pills are banned (DESIGN.md §12). Delete after migration.
});
```

## 3. Spacing

Strict 4pt base. Same keys, four value changes:

```ts
export const space = Object.freeze({
  none: 0,
  xxs: 4,   // was 2
  xs: 8,    // was 6
  sm: 12,   // was 10
  md: 16,   // unchanged
  lg: 24,   // unchanged
  xl: 32,   // was 34
  xxl: 48,  // unchanged
});
```

## 4. Fonts and type scale

```ts
export const font = Object.freeze({
  // Sans is the platform default (undefined fontFamily). Named here so a future
  // custom-font swap (Archivo Black / Space Mono, see DESIGN.md §4.1) is one edit.
  sans: undefined as string | undefined,
  mono: Platform.select({
    ios: 'Menlo',
    default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }) as string,
});
```

```ts
export const type = Object.freeze({
  display:    { fontSize: 40, lineHeight: 42, fontWeight: '900', letterSpacing: -1.5, textTransform: 'uppercase' },
  title:      { fontSize: 28, lineHeight: 32, fontWeight: '900', letterSpacing: -0.6, textTransform: 'uppercase' },
  heading:    { fontSize: 19, lineHeight: 24, fontWeight: '800', letterSpacing: -0.3 },
  subheading: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  body:       { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  caption:    { fontSize: 13, lineHeight: 17, fontWeight: '400' },
  numeral:    { fontSize: 34, lineHeight: 38, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  label:      { fontFamily: font.mono, fontSize: 11, lineHeight: 14, fontWeight: '400', letterSpacing: 1.5, textTransform: 'uppercase' },
  micro:      { fontFamily: font.mono, fontSize: 10, lineHeight: 13, fontWeight: '400', letterSpacing: 1.2, textTransform: 'uppercase' },
  mono:       { fontFamily: font.mono, fontSize: 13, lineHeight: 19 },
  monoSmall:  { fontFamily: font.mono, fontSize: 11, lineHeight: 16 },
}) satisfies Readonly<Record<string, TextStyle>>;
```

Changes vs current: `display`/`title` grow, go weight 900, uppercase; weights across
body/caption drop from 500→400 (editorial regular, ink contrast carries legibility);
`label` moves from bold sans to tracked regular mono — **this is the biggest visual
change in the app**; new variants `numeral` and `micro`; old `label` call sites compile
unchanged (same name).

`MAX_SCALE` additions in `src/ui/text.tsx` when implemented: `numeral: 1.3`,
`micro: 1.3`; `display`/`title` drop to 1.2.

## 5. Layout

```ts
export const layout = Object.freeze({
  minTouch: 44,           // unchanged
  hairline: StyleSheet.hairlineWidth, // was 1 — true 1px physical hairlines
  ruleEmphasis: 2,        // NEW — the 2pt emphasis/selection rule (DESIGN.md §6)
  margin: 20,             // NEW — the page gutter; replaces ad-hoc space.md padding
  rowHeight: 52,          // NEW — uniform list row minimum
  tabBarHeight: 61,       // unchanged (floor, not actual)
  contentMaxWidth: 680,   // was 760 — tighter editorial column on web
  hitSlop: Object.freeze({ top: 8, bottom: 8, left: 8, right: 8 }), // unchanged
});
```

## 6. Motion

```ts
export const motion = Object.freeze({
  instant: 0,
  fast: 120,      // unchanged — selection flips, underline slide
  base: 180,      // unchanged — presses, fades
  slow: 240,      // was 280 — sheet slide; nothing may exceed this
  pressOpacity: 0.55, // NEW — press feedback is opacity, not scale
  pulse: 1200,    // NEW — live-dot loop duration
  blink: 600,     // NEW — streaming cursor
  // DELETED: pressScale (no scale transforms), spring (no springs; ease-out only)
});
```

Reduced motion (unchanged contract, restated): gate on `useReducedMotion()` — all
translations become opacity-only, pulse/blink hold full opacity, durations halve.

## 7. Elevation — deleted

The design is flat. `Elevation`, `ElevationScale`, `makeElevation`, and
`theme.elevation` are **deleted**. `Palette.shadow` becomes dead and should be removed
from the interface in the same pass (both listed above only so a staged migration
compiles). Any component reading `theme.elevation.*` switches to `undefined`/no style.

## 8. Migration map — every token whose meaning changes or dies

| Token | Fate |
|---|---|
| `colors.accent` | Value change only, but note: it is now **orange**, and blue is gone app-wide (icon/splash assets will need a follow-up). |
| `colors.accentGraphic` | **New.** Non-text marks. Anywhere the old code drew a ≥3pt decoration in `accent`, use this. |
| `colors.accentDim` | **Meaning change:** muted-fill → disabled/track tint. Audit all 3 current uses. |
| `colors.black` | **Meaning change:** "true black utility" → alias of `machine`. |
| `colors.machine/onMachine/onMachineDim` | **New.** Terminal + video panels, both themes. |
| `colors.surface` | **Meaning narrows:** was "card fill", now "input fill". Any non-input `surface` fill is a card smell — remove it. |
| `colors.surfaceAlt` | Meaning narrows likewise: recessed control fields only. |
| `colors.shadow` | **Delete** with elevation. |
| `radius.md/lg/xl/pill` | **Delete** after call sites migrate to `xs`/`sm`. |
| `space.xxs/xs/sm/xl` | Value changes (2→4, 6→8, 10→12, 34→32). Mechanical. |
| `type.label` | **Meaning change:** bold sans caps → tracked mono caps. Same name, every call site restyles automatically — review each for the never-bold rule. |
| `type.numeral`, `type.micro` | **New.** |
| `layout.hairline` | 1 → `StyleSheet.hairlineWidth`. |
| `layout.margin/rowHeight/ruleEmphasis` | **New.** |
| `motion.pressScale`, `motion.spring` | **Delete.** |
| `motion.pressOpacity/pulse/blink` | **New.** |
| `theme.elevation`, `Elevation`, `ElevationScale` | **Delete.** |
| `<Card>` (`src/ui/layout.tsx`) | **Delete** after the 17 call-site screens migrate to Section/LedgerRow/Meter patterns (DESIGN.md §7). |
| Legacy `colors` export | Keep resolving to `darkPalette` (compat), unchanged behaviour. |

Everything not listed keeps its name, meaning, and (for structure/behaviour tokens)
value; only palette hexes change.

## 9. Contrast verifier

Re-run whenever a hex or alpha changes; all text pairs must print ≥ 4.50, all
`accentGraphic`/track marks ≥ 3.00.

```js
// node contrast.mjs
const hex = h => { h = h.replace('#',''); return [0,2,4].map(i => parseInt(h.slice(i, i+2), 16)); };
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = rgb => 0.2126*lin(rgb[0]) + 0.7152*lin(rgb[1]) + 0.0722*lin(rgb[2]);
const ratio = (a, b) => { const [x, y] = [L(hex(a)), L(hex(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (fg, alpha, bg) => { const f = hex(fg), b = hex(bg);
  return '#' + f.map((v, i) => Math.round(v*alpha + b[i]*(1-alpha)).toString(16).padStart(2, '0')).join(''); };
// e.g. text on worst backdrop:            ratio('#161513', '#E1DED9')
// e.g. on-soft composited over surfaceAlt: ratio('#9A3000', over('#B03700', 0.10, '#E1DED9'))
```
