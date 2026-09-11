// Where the trackpad's dots go.
//
// Fieldwork's mockup gives the pad a faint regular dot grid — the one place in
// the app with a material rather than a fill. Pure so the grid can be tested
// and so the view never does arithmetic in a render.

/** Spacing between dot centres, points. */
export const PAD_DOT_PITCH = 14;
/** Drawn dot diameter, points. */
export const PAD_DOT_SIZE = 1.5;
/** Ceiling on drawn dots. A pad this big on a phone is already a bug, but an
 *  unbounded grid on a desktop-sized window would mount thousands of views. */
export const PAD_DOT_LIMIT = 600;

export interface PadDot {
  readonly x: number;
  readonly y: number;
}

/**
 * The dot centres for a pad of this size, inset by half a pitch so the grid
 * never collides with the pad's rounded corners. Returns an empty list — not a
 * single sad dot — for a pad too small to hold a grid at all.
 */
export function padDots(width: number, height: number): readonly PadDot[] {
  if (!(width > PAD_DOT_PITCH) || !(height > PAD_DOT_PITCH)) return [];
  const inset = PAD_DOT_PITCH / 2;
  const cols = Math.floor((width - inset) / PAD_DOT_PITCH);
  const rows = Math.floor((height - inset) / PAD_DOT_PITCH);
  if (cols < 1 || rows < 1) return [];

  const dots: PadDot[] = [];
  for (let row = 0; row < rows && dots.length < PAD_DOT_LIMIT; row += 1) {
    for (let col = 0; col < cols && dots.length < PAD_DOT_LIMIT; col += 1) {
      dots.push({ x: inset + col * PAD_DOT_PITCH, y: inset + row * PAD_DOT_PITCH });
    }
  }
  return dots;
}
