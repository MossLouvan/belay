// The movable mascot button — geometry, as pure numbers.
//
// While immersive the beluga floats over the picture (Parsec-style): a tap
// brings the control bar back, a drag moves it, and on release it snaps to
// the nearest left/right edge. This module owns every decision about WHERE
// it may be, so the clamp can be tested without a device:
//
//  - tap vs drag is a distance threshold on the touch's travel;
//  - the x is never free: the button lives on one edge or the other;
//  - the y is clamped inside the safe area, above the bottom-edge reveal
//    strip, and off the HUD block (Connected pill, recording strip, notices)
//    — except for its own top-right slot, which the HUD row keeps empty.
//
// Pure module: no React, no react-native.

import { REVEAL_EDGE_PX } from './autohide.ts';

/** The button's box, one comfortable touch target. */
export const MASCOT_BUTTON_SIZE = 48;

/** Travel below this is a tap; at or above it the touch becomes a drag. */
export const MASCOT_DRAG_THRESHOLD_PX = 6;

/** Air between the button and the safe-area edge it hugs (theme.space.sm). */
export const MASCOT_EDGE_MARGIN_PX = 12;

export type MascotSide = 'left' | 'right';

/** Where the button rests: an edge, and a y in screen points. */
export interface MascotPlacement {
  readonly side: MascotSide;
  readonly y: number;
}

export interface MascotBounds {
  readonly width: number;
  readonly height: number;
  readonly insets: {
    readonly top: number;
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** Top of the HUD row — the mascot's own slot sits here, on the right. */
  readonly hudTop: number;
  /** Bottom of the whole HUD block; the left side may not rise above it. */
  readonly hudBottom: number;
}

export const isMascotDrag = (dx: number, dy: number): boolean =>
  Math.hypot(dx, dy) >= MASCOT_DRAG_THRESHOLD_PX;

/** Top-right, in the HUD row: where the mascot has always lived. */
export const defaultMascotPlacement = (bounds: MascotBounds): MascotPlacement => ({
  side: 'right',
  y: bounds.hudTop,
});

export const mascotX = (side: MascotSide, { width, insets }: MascotBounds): number =>
  side === 'left'
    ? insets.left + MASCOT_EDGE_MARGIN_PX
    : width - insets.right - MASCOT_EDGE_MARGIN_PX - MASCOT_BUTTON_SIZE;

/** The placement with its y forced legal for the given side and screen. */
export const clampMascot = ({ side, y }: MascotPlacement, bounds: MascotBounds): MascotPlacement => {
  const floor = bounds.height - Math.max(bounds.insets.bottom, REVEAL_EDGE_PX) - MASCOT_EDGE_MARGIN_PX - MASCOT_BUTTON_SIZE;
  // Right: the slot at hudTop is allowed; anywhere else in the HUD band is
  // not, and resolves back to the slot. Left: the whole band is off limits.
  const inBand = y < bounds.hudBottom;
  const legal = side === 'right' ? (inBand ? bounds.hudTop : y) : Math.max(y, bounds.hudBottom);
  const minY = side === 'right' ? bounds.hudTop : bounds.hudBottom;
  return { side, y: Math.max(minY, Math.min(legal, Math.max(minY, floor))) };
};

/** Where a button released at (x, y) comes to rest: nearest edge, clamped. */
export const snapMascot = (x: number, y: number, bounds: MascotBounds): MascotPlacement => {
  const centre = x + MASCOT_BUTTON_SIZE / 2;
  return clampMascot({ side: centre < bounds.width / 2 ? 'left' : 'right', y }, bounds);
};
