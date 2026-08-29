// Layout data and paging math for the on-screen key bar (KeyBar v2).
//
// The bar shows two rows of 44pt caps and pages horizontally (a paged
// ScrollView, not a free scroll), so keys live at fixed, learnable positions:
// page 1 is basics + sticky modifiers, page 2 is navigation with an inverted-T
// arrow cluster drawn as chevron glyphs, page 3 is shortcuts.
//
// Pure functions only — exercised by keybar.test.mjs under Node's type
// stripping, so nothing here may import React, JSX, or (by value) any other
// local module; the KeySpec list is passed IN by the caller instead.

// Type-only, and marked as such: erased before Node ever resolves it.
import type { KeySpec } from './model';
import type { StickyMod } from './mods';

/** Direction of a view-drawn chevron replacing a text label on a cap. */
export type ArrowGlyph = 'up' | 'down' | 'left' | 'right';

export type KeyBarCell =
  | { readonly kind: 'key'; readonly spec: KeySpec; readonly glyph?: ArrowGlyph }
  | { readonly kind: 'mod'; readonly mod: StickyMod; readonly label: string; readonly macLabel: string };

export interface KeyBarPage {
  readonly top: readonly KeyBarCell[];
  readonly bottom: readonly KeyBarCell[];
}

/**
 * Builds the pages from the app's KeySpec list. Row lengths may differ — caps
 * flex to fill their row — but stay at four or fewer so every cap clears 44pt
 * wide on a small phone. An unknown id throws at module load in dev and in the
 * tests, rather than rendering a dead cap.
 *
 * The plain `Win` KeySpec is deliberately absent: the Win/Cmd cap here is the
 * sticky modifier, which also covers "press Win alone" (tap it, tap it again).
 */
export function buildKeyPages(keys: readonly KeySpec[]): readonly KeyBarPage[] {
  const byId = new Map(keys.map((spec) => [spec.id, spec]));

  const key = (id: string, glyph?: ArrowGlyph): KeyBarCell => {
    const spec = byId.get(id);
    if (!spec) throw new Error(`keybar references unknown key "${id}"`);
    return glyph ? { kind: 'key', spec, glyph } : { kind: 'key', spec };
  };

  const mod = (m: StickyMod, label: string, macLabel: string): KeyBarCell => ({
    kind: 'mod',
    mod: m,
    label,
    macLabel,
  });

  return [
    {
      top: [key('Esc'), key('Tab'), key('Enter'), key('Bksp')],
      bottom: [mod('ctrl', 'Ctrl', '⌃'), mod('alt', 'Alt', '⌥'), mod('shift', 'Shift', '⇧'), mod('win', 'Win', '⌘')],
    },
    {
      top: [key('Home'), key('Up', 'up'), key('End'), key('PgUp')],
      bottom: [key('Left', 'left'), key('Down', 'down'), key('Right', 'right'), key('PgDn')],
    },
    {
      top: [key('Ctrl+C'), key('Ctrl+V'), key('Ctrl+A'), key('Ctrl+Z')],
      bottom: [key('Alt+Tab'), key('Del'), key('F5')],
    },
  ];
}

export const cellsOf = (page: KeyBarPage): readonly KeyBarCell[] => [...page.top, ...page.bottom];

/**
 * Which page a paged ScrollView has settled on. Offsets from momentum can
 * overshoot by a few px and the last page's offset can exceed
 * (pageCount-1)*width by a rubber-band margin, hence the round + clamp.
 */
export function pageIndexFor(offsetX: number, pageWidth: number, pageCount: number): number {
  if (pageWidth <= 0 || pageCount <= 0 || !Number.isFinite(offsetX)) return 0;
  return Math.max(0, Math.min(pageCount - 1, Math.round(offsetX / pageWidth)));
}
