// The two appearances, as data.
//
// "Current" and "Fieldwork" are not just two palettes: the concept mockups
// (output/design-concepts-2026-09-11/) differ in shape as well as colour —
// Current leads with a big left-aligned page title and a full-width Connect
// inside the card; Fieldwork uses a compact centred header and puts Connect in
// the card's right column. Every one of those differences lives here as a
// named switch so screens read `look.connectInline` instead of guessing from
// `theme.isDark`, and so the list of what actually differs is one file long.
//
// Pure data + pure lookup: no React, no react-native. The hook that resolves
// it from the active scheme is ./use-look.ts.

import type { ColorScheme } from '../theme';

export type LookName = 'current' | 'fieldwork';

/** Shape switches for one appearance. Colour lives in the palette, not here. */
export interface Look {
  readonly name: LookName;
  /** Page title on the computers list. */
  readonly devicesTitle: string;
  /** The line under it; null renders no subtitle at all. */
  readonly devicesSubtitle: string | null;
  /** Corner radius for cards, thumbnails and the trackpad. */
  readonly cardRadius: number;
  /** Cards carry the signature hairline border (Current). Fieldwork separates
   *  a card from the page with fill alone — a rule on near-black reads as a
   *  seam, not a card edge. */
  readonly cardBorder: boolean;
  /** Radius for buttons, pills and segment chips. */
  readonly controlRadius: number;
  /** Extra air between the page title block and the content under it.
   *  Current lets the title breathe; Fieldwork packs the list up under it. */
  readonly titleGap: number;
  /** Connect sits in the card's right column (Fieldwork) rather than
   *  full-width beneath the row (Current). */
  readonly connectInline: boolean;
  /** The desktop screen leads with a display-size left-aligned host name
   *  (Current) rather than a compact centred title (Fieldwork). */
  readonly screenTitleLarge: boolean;
  /** The word beside the back chevron; null renders the chevron alone. */
  readonly backLabel: string | null;
  /** The trackpad carries a faint dot texture. */
  readonly padTexture: boolean;
  /** The trackpad carries the "Swipe to move cursor" hint. */
  readonly padHint: boolean;
  /** The selected segment is a muted soft fill (Fieldwork) rather than the
   *  solid accent (Current). */
  readonly segmentSoft: boolean;
  /** The list header's trailing control adds a computer (Current: a filled +)
   *  rather than opening the menu (Fieldwork: an outlined ⋯). */
  readonly headerAction: 'add' | 'menu';
  /** Device rows lead with a wide 16:10 preview tile (Fieldwork) rather than a
   *  square line glyph (Current). */
  readonly deviceThumbWide: boolean;
}

const CURRENT: Look = Object.freeze({
  name: 'current',
  devicesTitle: 'Your computers',
  devicesSubtitle: 'Connect to your computer.',
  cardRadius: 16,
  cardBorder: true,
  controlRadius: 10,
  titleGap: 36,
  connectInline: false,
  screenTitleLarge: true,
  backLabel: 'Computers',
  padTexture: false,
  padHint: true,
  segmentSoft: false,
  headerAction: 'add',
  deviceThumbWide: false,
});

const FIELDWORK: Look = Object.freeze({
  name: 'fieldwork',
  devicesTitle: 'Computers',
  devicesSubtitle: null,
  cardRadius: 12,
  cardBorder: false,
  controlRadius: 8,
  titleGap: 0,
  connectInline: true,
  screenTitleLarge: false,
  backLabel: null,
  padTexture: true,
  padHint: false,
  segmentSoft: true,
  headerAction: 'menu',
  deviceThumbWide: true,
});

export const looks: Readonly<Record<LookName, Look>> = Object.freeze({
  current: CURRENT,
  fieldwork: FIELDWORK,
});

/**
 * The appearance a colour scheme resolves to. The two are 1:1 by design —
 * `light` is Current's ground and `dark` is Fieldwork's — so a screen never
 * has to hold both a scheme and an appearance.
 */
export function lookFor(scheme: ColorScheme): Look {
  return scheme === 'light' ? CURRENT : FIELDWORK;
}
