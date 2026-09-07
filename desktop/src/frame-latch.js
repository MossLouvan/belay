// A one-deep, newest-wins slot between "a frame arrived" and "it is decoded".
//
// Decoding is asynchronous and can be slower than frames arrive — a big frame,
// a busy machine, a burst after a stall. Decoding every frame as it lands
// means an unbounded queue of decodes racing each other: memory grows, latency
// grows with it, and the frames finish out of order so an older picture can
// land on top of a newer one. This latch decodes one frame at a time and keeps
// exactly one more waiting; anything that arrives while both are taken
// replaces the waiting one. The picture on screen is always the newest frame
// that finished decoding, and the backlog can never exceed one frame.
//
// Pure: every function returns a new latch, so the renderer's `let latch`
// is the only state and it is replaced, never mutated.

/** @typedef {{ busy: boolean, pending: unknown, dropped: number }} Latch */

/** @returns {Latch} */
export const emptyLatch = () => Object.freeze({ busy: false, pending: null, dropped: 0 });

/**
 * A frame arrived. Returns the frame to decode now (or null) and the next latch.
 * @template T @param {Latch} latch @param {T} frame
 * @returns {{ latch: Latch, decode: T | null }}
 */
export function offer(latch, frame) {
  if (!latch.busy) return { latch: Object.freeze({ ...latch, busy: true }), decode: frame };
  const dropped = latch.pending === null ? latch.dropped : latch.dropped + 1;
  return { latch: Object.freeze({ ...latch, pending: frame, dropped }), decode: null };
}

/**
 * A decode finished (well or badly — both free the slot). Returns the parked
 * frame to decode next, if any, and the next latch.
 * @param {Latch} latch @returns {{ latch: Latch, decode: unknown }}
 */
export function settle(latch) {
  if (latch.pending === null) return { latch: Object.freeze({ ...latch, busy: false }), decode: null };
  return { latch: Object.freeze({ ...latch, busy: true, pending: null }), decode: latch.pending };
}
