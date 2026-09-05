// Pure logic for the collaborator cursors drawn over the remote screen.
//
// The host broadcasts everyone's virtual cursor on /ws/cursors (server
// cursor-channel.ts). This module owns the parts with no React in them: the
// wire parser, the self-filter, and the geometry that keeps a name tag beside
// its cursor instead of half off the edge of the picture.
//
// JSX-free on purpose — cursors.test.mjs imports it directly.

/** One collaborator's cursor, exactly as the host sends it. */
export interface RemoteCursor {
  readonly id: string;
  readonly name: string;
  /** `#rrggbb`, assigned by the host and stable for that device. */
  readonly color: string;
  /** Normalized 0..1 against the frame the cursor was moved on. */
  readonly x: number;
  readonly y: number;
  /** Which monitor these coordinates belong to, when the host said. */
  readonly screen?: number;
  readonly window?: string;
  /** True while this person holds the input floor — i.e. their clicks land. */
  readonly acting: boolean;
}

export interface CursorHello {
  readonly kind: 'hello';
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export interface CursorList {
  readonly kind: 'cursors';
  readonly cursors: readonly RemoteCursor[];
}

export type CursorMessage = CursorHello | CursorList;

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const isHexColor = (v: unknown): v is string =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/**
 * Parse one frame off the wire, or null.
 *
 * Every field is checked rather than trusted. The host is authenticated, but a
 * malformed row here would be rendered as a NaN-positioned View, and on React
 * Native that is a hard crash rather than a nothing — a bad frame must drop out
 * here, not on the way to the layout engine.
 */
export function parseCursorMessage(data: string): CursorMessage | null {
  let msg: unknown;
  try { msg = JSON.parse(data); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;

  if (m.type === 'hello') {
    if (typeof m.id !== 'string' || !m.id) return null;
    return {
      kind: 'hello',
      id: m.id,
      name: typeof m.name === 'string' ? m.name : '',
      color: isHexColor(m.color) ? m.color : '#cccccc',
    };
  }

  if (m.type === 'cursors') {
    if (!Array.isArray(m.cursors)) return null;
    const cursors: RemoteCursor[] = [];
    for (const raw of m.cursors) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.id !== 'string' || !c.id) continue;
      if (!isFiniteNumber(c.x) || !isFiniteNumber(c.y)) continue;
      if (!isHexColor(c.color)) continue;
      cursors.push({
        id: c.id,
        name: typeof c.name === 'string' ? c.name : '',
        color: c.color,
        x: Math.min(1, Math.max(0, c.x)),
        y: Math.min(1, Math.max(0, c.y)),
        ...(isFiniteNumber(c.screen) ? { screen: c.screen } : {}),
        ...(typeof c.window === 'string' && c.window ? { window: c.window } : {}),
        acting: c.acting === true,
      });
    }
    return { kind: 'cursors', cursors };
  }

  return null;
}

/**
 * The cursors this client should actually draw.
 *
 * Drops our own — the app already renders the local pointer and drawing the
 * echo would double it a frame behind — and anything pointing at a surface
 * other than the one on screen, so a collaborator on monitor 2 does not appear
 * as a ghost on monitor 1.
 */
export function visibleCursors(
  cursors: readonly RemoteCursor[],
  selfId: string | null,
  surface: { screen?: number; window?: string } = {},
): readonly RemoteCursor[] {
  return cursors.filter((c) => {
    if (selfId !== null && c.id === selfId) return false;
    if (surface.window !== undefined) return c.window === surface.window;
    if (surface.screen !== undefined) return (c.screen ?? 0) === surface.screen;
    return true;
  });
}

/** Name-tag box metrics. The tag is small on purpose: it is an identifier, not
 *  a label, and several of them must be able to share a screen. */
export const TAG_HEIGHT = 18;
export const TAG_GAP = 10;
export const TAG_CHAR_WIDTH = 6.6;
export const TAG_PADDING = 14;

/** Roughly how wide a tag will render. Cheap and monospace-ish rather than
 *  measured: an approximation is enough to decide which side to flip to. */
export function tagWidth(name: string): number {
  return Math.ceil(name.length * TAG_CHAR_WIDTH) + TAG_PADDING;
}

export interface TagPlacement {
  readonly left: number;
  readonly top: number;
  /** Which side of the cursor the tag ended up on, for the caller's styling. */
  readonly side: 'right' | 'left';
}

/**
 * Put the name tag beside its cursor, and keep it on screen.
 *
 * Right of the cursor by default, because that is where a pointer's own
 * hotspot leaves room. It flips to the left rather than being clipped when the
 * cursor is near the right edge, and the vertical position is clamped so a tag
 * at the very bottom stays readable.
 */
export function placeTag(
  cursorX: number,
  cursorY: number,
  name: string,
  viewWidth: number,
  viewHeight: number,
): TagPlacement {
  const w = tagWidth(name);
  const rightEdge = cursorX + TAG_GAP + w;
  const side: 'right' | 'left' = rightEdge <= viewWidth ? 'right' : 'left';
  const left = side === 'right'
    ? cursorX + TAG_GAP
    : Math.max(0, cursorX - TAG_GAP - w);
  const top = Math.min(Math.max(0, cursorY + TAG_GAP), Math.max(0, viewHeight - TAG_HEIGHT));
  return { left, top, side };
}

/**
 * Ink that stays readable on a given tag colour.
 *
 * The host picks light pastels, so this is nearly always the dark ink — but
 * "nearly always" is not a contract, and a name rendered white-on-pastel is
 * unreadable rather than merely ugly. Uses the WCAG relative-luminance
 * threshold rather than a naive channel average.
 */
export function inkOn(hex: string): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return '#101010';
  const channel = (h: string): number => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(m[1]!) + 0.7152 * channel(m[2]!) + 0.0722 * channel(m[3]!);
  // Contrast against white vs black, picking whichever clears further.
  return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05) ? '#101010' : '#f6f4f1';
}

/** Normalized position to a pixel offset inside the rendered frame. */
export function toPixels(
  c: { x: number; y: number },
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } {
  return { x: c.x * viewWidth, y: c.y * viewHeight };
}
