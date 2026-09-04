// Who is pointing where. One virtual cursor per connected device, tracked
// here and drawn by every client — never by the OS.
//
// This is the half of the collaboration feature that costs nothing: moving a
// virtual cursor touches no OS state at all, so any number of people can point
// at the same desktop simultaneously and none of them takes the pointer away
// from whoever is physically sitting at the machine. Only *acting* on the
// desktop is contended, and that is input-floor.ts's problem, not this file's.
//
// Positions are normalized 0..1 against the frame the client is showing,
// exactly like the /input routes, and carry the same `screen` / `window`
// discriminator — a cursor on monitor 2 must not be painted on monitor 1.
//
// Nothing here is persisted. A cursor is presence, and presence dies with the
// connection.

import { createHash } from 'node:crypto';

/** Hue band reserved for Belay's own accent orange, so a user cursor is never
 *  mistaken for a piece of the UI. Matches `accent` in app/src/theme.ts. */
const BRAND_HUE_MIN = 6;
const BRAND_HUE_MAX = 34;

/** Minimum separation between two assigned hues, in degrees. Below roughly
 *  this, two pastels of the same lightness stop being tellable apart at cursor
 *  size — which is the entire point of colouring them. */
const MIN_HUE_GAP = 26;

/** Pastel, not saturated: these sit on top of arbitrary desktop content, and a
 *  vivid fill fights whatever is under it. The clients draw a dark outline, so
 *  a light fill stays legible on a light desktop too. */
const CURSOR_SATURATION = 0.72;
const CURSOR_LIGHTNESS = 0.76;

/** The golden angle. Stepping by it visits the hue circle without clustering,
 *  so the collision walk below finds a distant free hue rather than shuffling
 *  a few degrees into the next near-collision. */
const GOLDEN_ANGLE = 137.508;

/** A cursor that has not moved in this long stops being broadcast. The device
 *  may still be connected and watching; it just is not pointing at anything,
 *  and a stack of abandoned cursors is worse than no cursors. */
export const CURSOR_IDLE_MS = 45_000;

/** What the client needs to paint one remote cursor. */
export interface CursorRow {
  /** Stable public id for this device. Derived from the token but NOT the
   *  token: this row is broadcast to every other connected device. */
  readonly id: string;
  readonly name: string;
  /** `#rrggbb`, light enough to read as a highlight rather than a UI element. */
  readonly color: string;
  /** Normalized 0..1 against the frame this cursor was last moved on. */
  readonly x: number;
  readonly y: number;
  /** Which surface the coordinates belong to; mirrors the /input routes. */
  readonly screen?: number;
  readonly window?: string;
  /** True while this device holds the input floor — the client draws the
   *  cursor solid instead of hollow, so it is obvious who can actually click. */
  readonly acting: boolean;
}

interface CursorState {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  x: number;
  y: number;
  screen?: number;
  window?: string;
  movedAt: number;
}

/**
 * A stable, non-secret id for a device.
 *
 * Cursor rows go to every other connected device, so the key they are grouped
 * by must not be the bearer token — broadcasting that would hand every paired
 * phone the credentials of every other one. A SHA-256 prefix over a
 * high-entropy token is stable across reconnects and reveals nothing.
 */
export function publicIdOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 10);
}

/** HSL in 0..1 (hue in degrees) to `#rrggbb`. */
export function hslToHex(hDeg: number, s: number, l: number): string {
  const h = ((hDeg % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let v = t;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  const hex = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${hex(channel(h + 1 / 3))}${hex(channel(h))}${hex(channel(h - 1 / 3))}`;
}

/** True when a hue lands in the reserved brand band. */
export function isBrandHue(hue: number): boolean {
  const h = ((hue % 360) + 360) % 360;
  return h >= BRAND_HUE_MIN && h <= BRAND_HUE_MAX;
}

/** Smallest distance between two hues on the circle, in degrees. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

/**
 * Pick this device's hue: random-looking, stable, and not already in use.
 *
 * The seed is the device's own id, so a phone that drops off a flaky network
 * comes back the same colour rather than making everyone re-learn who is who.
 * The walk then steps by the golden angle until the hue clears both the brand
 * band and every hue already on screen, so "random" never means "two people
 * get the same pastel blue".
 *
 * With enough simultaneous users the circle genuinely runs out of well-spaced
 * hues; past that the walk gives up and returns its best candidate rather than
 * looping. Colours start repeating, which is a far better failure than a hang.
 */
export function pickHue(seed: string, taken: readonly number[]): number {
  const digest = createHash('sha256').update(seed).digest();
  let hue = (digest.readUInt16BE(0) / 0xffff) * 360;
  const clear = (h: number): boolean =>
    !isBrandHue(h) && taken.every((t) => hueDistance(h, t) >= MIN_HUE_GAP);
  for (let i = 0; i < 64 && !clear(hue); i += 1) hue = (hue + GOLDEN_ANGLE) % 360;
  return hue;
}

/** The colour for a device, given the hues already handed out. */
export function pickColor(seed: string, taken: readonly number[]): { hue: number; hex: string } {
  const hue = pickHue(seed, taken);
  return { hue, hex: hslToHex(hue, CURSOR_SATURATION, CURSOR_LIGHTNESS) };
}

/** Clamp a wire coordinate into 0..1, rejecting the non-finite. */
export function clampUnit(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

export interface CursorRegistry {
  /** Register a device's cursor. Idempotent — a second call keeps the colour. */
  join(token: string, name: string, now?: number): CursorRow;
  /** Update a position. Returns false for an unjoined device or bad coords. */
  move(
    token: string,
    x: unknown,
    y: unknown,
    surface?: { screen?: number; window?: string },
    now?: number,
  ): boolean;
  leave(token: string): void;
  /** Everyone still pointing, minus the caller when `exceptToken` is given. */
  rows(now?: number, exceptToken?: string): readonly CursorRow[];
  /** The public id a token maps to, without joining it. */
  idOf(token: string): string;
  size(): number;
  reset(): void;
}

/**
 * The live set of cursors.
 *
 * Built as a factory rather than module-level state so tests get a fresh
 * registry per case and the production one is created once in index.ts.
 * `acting` is injected rather than imported: the registry has no opinion about
 * who holds the floor, it just paints what input-floor.ts decides.
 */
export function createCursorRegistry(deps: {
  /** The public id currently holding the input floor, or null. */
  readonly actingId: () => string | null;
} = { actingId: () => null }): CursorRegistry {
  const byToken = new Map<string, CursorState>();

  const takenHues = (): number[] =>
    [...byToken.values()].map((c) => hueOfHex(c.color));

  return {
    join(token, name, now = Date.now()) {
      const existing = byToken.get(token);
      if (existing) return toRow(existing, deps.actingId());
      const id = publicIdOf(token);
      const { hex } = pickColor(id, takenHues());
      const state: CursorState = {
        id, name, color: hex,
        // Off-frame until the first move, so a device that connects and never
        // points does not park a cursor in someone's top-left corner.
        x: -1, y: -1, movedAt: now,
      };
      byToken.set(token, state);
      return toRow(state, deps.actingId());
    },

    move(token, x, y, surface, now = Date.now()) {
      const state = byToken.get(token);
      if (!state) return false;
      const cx = clampUnit(x);
      const cy = clampUnit(y);
      if (cx === null || cy === null) return false;
      state.x = cx;
      state.y = cy;
      // A surface is sticky: clients send it on the first move onto a monitor
      // and omit it afterwards, exactly as the /input routes accept it.
      if (surface && typeof surface.screen === 'number') {
        state.screen = surface.screen;
        state.window = undefined;
      } else if (surface && typeof surface.window === 'string' && surface.window) {
        state.window = surface.window;
        state.screen = undefined;
      }
      state.movedAt = now;
      return true;
    },

    leave(token) { byToken.delete(token); },

    rows(now = Date.now(), exceptToken?: string) {
      const acting = deps.actingId();
      const out: CursorRow[] = [];
      for (const [token, state] of byToken) {
        if (token === exceptToken) continue;
        if (state.x < 0 || state.y < 0) continue;          // never pointed
        if (now - state.movedAt > CURSOR_IDLE_MS) continue; // stopped pointing
        out.push(toRow(state, acting));
      }
      // Stable order so an unchanged set serializes to an unchanged string and
      // the channel's diff can suppress the send.
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    idOf: publicIdOf,
    size: () => byToken.size,
    reset: () => byToken.clear(),
  };
}

function toRow(state: CursorState, actingId: string | null): CursorRow {
  const row: CursorRow = {
    id: state.id,
    name: state.name,
    color: state.color,
    x: state.x,
    y: state.y,
    acting: actingId === state.id,
  };
  if (state.screen !== undefined) return { ...row, screen: state.screen };
  if (state.window !== undefined) return { ...row, window: state.window };
  return row;
}

/** Recover the hue of a colour this module produced, for collision checks. */
export function hueOfHex(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i]!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}
