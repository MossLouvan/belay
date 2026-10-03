// The host's REAL pointer, drawn by the phone over an H.264 picture.
//
// ScreenCaptureKit bakes the macOS pointer into the frame at the desktop's
// scale, so a 3420-wide Retina desktop shown on a phone leaves it a few pixels
// across — "why is the cursor not a cursor?". When the phone asks for it
// (`?pointer=1` with `codec=h264`), the host stops baking it in and instead
// sends `{type:'pointer', x, y}` on every move plus the cursor's own image
// (`cursor`) whenever its shape changes — arrow, I-beam, hand, resize, all of
// them, exactly as macOS draws them. The phone draws that image at a fixed
// on-glass size, so it reads as a pointer at any zoom.
//
// JSX-free: host-pointer.test.mjs imports it directly.

import type { Size } from './model';

/** The cursor's image as macOS draws it: PNG, its size and hotspot in points. */
export interface PointerImage {
  readonly png: string;
  readonly w: number;
  readonly h: number;
  readonly hx: number;
  readonly hy: number;
}

export interface PointerMessage {
  /** Normalized 0..1 against the captured display; outside means elsewhere. */
  readonly x: number;
  readonly y: number;
  /** Present only when the shape changed. */
  readonly cursor: PointerImage | null;
}

/**
 * Phone points per macOS cursor point. 1 draws the pointer the size it is on
 * the Mac's own glass: unmistakably a pointer, still small enough to aim with.
 * The calibration knob if it ever reads too big or too small.
 */
export const POINTER_SCALE = 1;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const imageOf = (raw: unknown): PointerImage | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.png !== 'string' || c.png.length === 0) return null;
  if (![c.w, c.h, c.hx, c.hy].every(finite) || !((c.w as number) > 0 && (c.h as number) > 0)) return null;
  return { png: c.png, w: c.w as number, h: c.h as number, hx: c.hx as number, hy: c.hy as number };
};

/** One `pointer` message off the socket, or null. Every field is checked: a
 *  NaN reaching a View's layout is a crash on React Native, not a no-op. */
export function parsePointerMessage(raw: unknown): PointerMessage | null {
  if (typeof raw !== 'string') return null;
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'pointer' || !finite(m.x) || !finite(m.y)) return null;
  return { x: m.x, y: m.y, cursor: imageOf(m.cursor) };
}

export interface PointerPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where to draw the pointer in STAGE coordinates (inside the zoom transform).
 * Sizes are divided by `zoom` so the transform scales them back to a constant
 * on-glass size, and the hotspot stays on the pixel being pointed at.
 */
export function placePointer(
  at: { readonly x: number; readonly y: number },
  cursor: PointerImage | null,
  stage: Size,
  zoom: number,
): PointerPlacement | null {
  if (!cursor || stage.w <= 0 || stage.h <= 0) return null;
  if (at.x < 0 || at.x > 1 || at.y < 0 || at.y > 1) return null;
  const k = POINTER_SCALE / (zoom > 0 ? zoom : 1);
  return {
    left: at.x * stage.w - cursor.hx * k,
    top: at.y * stage.h - cursor.hy * k,
    width: cursor.w * k,
    height: cursor.h * k,
  };
}
