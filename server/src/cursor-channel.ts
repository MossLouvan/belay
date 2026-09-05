// The /ws/cursors fan-out: one socket per connected device, carrying everyone's
// virtual cursor position at a rate a human eye can use.
//
// Shape follows agent-attention.ts — an injected-deps hub so tests never open a
// socket — with two differences. This channel is bidirectional (a client both
// sends its own cursor and receives everyone else's), and it coalesces on a
// timer rather than on every change: a finger dragging across a phone screen
// produces events far faster than anyone can see, and re-broadcasting each one
// to every peer would spend the whole link on pointer noise.
//
// Every socket receives the SAME wire, self included, and each client drops its
// own id when painting. One serialization, one diff, one send per tick — versus
// a per-socket rendering that would scale with the square of the party size.

import type { CursorRegistry, CursorRow } from './cursors.js';

/** Broadcast cadence. 20 Hz reads as continuous motion for a pointer that is
 *  interpolated client-side, at a twentieth of the traffic of frame-rate
 *  updates. */
export const CURSOR_FLUSH_MS = 50;

/** The subset of a ws socket the hub touches — fakeable in tests. */
export interface CursorSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  on(event: 'close', fn: () => void): void;
  on(event: 'message', fn: (data: unknown) => void): void;
}

/** Sent once, immediately, so a client knows which row is its own and what
 *  colour it was given — it draws its own cursor locally with no round trip. */
export function helloWire(self: CursorRow): string {
  return JSON.stringify({
    type: 'hello', id: self.id, name: self.name, color: self.color,
  });
}

export function cursorsWire(rows: readonly CursorRow[]): string {
  return JSON.stringify({ type: 'cursors', cursors: rows });
}

/**
 * Parse one inbound client frame.
 *
 * Returns null for anything unrecognised. This is a hot path fed by a remote
 * peer, so it validates rather than trusts: the registry clamps coordinates,
 * but a frame that is not even an object must not reach it.
 */
export function parseCursorFrame(data: unknown): {
  x: unknown; y: unknown; screen?: number; window?: string;
} | null {
  let raw: unknown = data;
  if (typeof raw !== 'string') {
    if (raw && typeof (raw as { toString?: unknown }).toString === 'function') {
      raw = String(raw);
    } else return null;
  }
  let msg: unknown;
  try { msg = JSON.parse(raw as string); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'move') return null;
  const out: { x: unknown; y: unknown; screen?: number; window?: string } = {
    x: m.x, y: m.y,
  };
  if (typeof m.screen === 'number' && Number.isFinite(m.screen)) out.screen = m.screen;
  else if (typeof m.window === 'string' && m.window) out.window = m.window;
  return out;
}

export interface CursorHub {
  /** Attach a socket for an authenticated device. */
  handle(ws: CursorSocket, token: string, name: string): void;
  /** Force a flush — used when the floor changes hands, which alters `acting`
   *  without any cursor having moved. */
  poke(): void;
  stop(): void;
}

export function createCursorHub(deps: {
  readonly registry: CursorRegistry;
  readonly flushMs?: number;
}): CursorHub {
  const flushMs = deps.flushMs ?? CURSOR_FLUSH_MS;
  const sockets = new Map<CursorSocket, string>();
  let lastWire: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    if (sockets.size === 0) { stopTimer(); return; }
    const wire = cursorsWire(deps.registry.rows());
    // An unchanged set costs nothing: a room where nobody is moving sends no
    // traffic at all, which is what makes a 20 Hz timer affordable.
    if (wire === lastWire) return;
    lastWire = wire;
    for (const ws of sockets.keys()) {
      try { if (ws.readyState === ws.OPEN) ws.send(wire); } catch { /* on its way out */ }
    }
  };

  const startTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(flush, flushMs);
    timer.unref?.();
  };

  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    lastWire = null;
  };

  return {
    handle(ws, token, name) {
      const self = deps.registry.join(token, name);
      sockets.set(ws, token);
      startTimer();
      try { ws.send(helloWire(self)); } catch { /* close will follow */ }

      ws.on('message', (data: unknown) => {
        const frame = parseCursorFrame(data);
        if (!frame) return;
        deps.registry.move(token, frame.x, frame.y, frame);
      });

      ws.on('close', () => {
        sockets.delete(ws);
        // Presence dies with the connection: the cursor goes immediately
        // rather than lingering until the idle timeout.
        deps.registry.leave(token);
        // A remaining peer sees the removal on the next tick. An empty room
        // just goes quiet — flush() stops the timer when nobody is left.
        if (sockets.size === 0) flush();
      });
    },

    poke: flush,
    stop: stopTimer,
  };
}
