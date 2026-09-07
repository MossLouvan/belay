// The link-health rules of a screen stream, kept pure so they can be tested
// without a socket.
//
// The stream socket only ever receives. A browser WebSocket sends no pings of
// its own, so when the host vanishes without a FIN — a PC that went to sleep,
// a laptop lid closed and reopened on another network, a VPN path that moved —
// nothing on this side ever notices: the socket reports OPEN, no `close`
// fires, and the last frame stays on screen for good. The host streams
// continuously (a frame or a capture error every tick), so silence is the one
// reliable sign that the link is dead. `stalled` is that sign.

export const LINK = Object.freeze({
  /** Silence this long on an open socket means the link is gone. */
  stallMs: 10_000,
  /** After this much silence the status stops quoting a frame rate. */
  quietMs: 2_000,
  /** Reconnects back off to a ceiling rather than hammering an absent host. */
  reconnect: Object.freeze({ base: 500, max: 8000 }),
});

/** Milliseconds to wait before reconnect attempt number `attempt`. */
export const reconnectDelay = (attempt, limits = LINK.reconnect) =>
  Math.min(limits.base * 2 ** attempt, limits.max);

/** Whether an open link that last spoke at `lastMessageAt` is dead as of `now`. */
export const stalled = (lastMessageAt, now, stallMs = LINK.stallMs) => now - lastMessageAt >= stallMs;

/**
 * What the status strip should say after one second of streaming, or null
 * to leave whatever it says now (a host error, "live") in place.
 *
 * The rate quoted is frames *drawn*, not received: a frame that arrived and
 * never reached the canvas is exactly the case the user needs to see.
 * @param {{ drawn: number, bytes: number, sinceMessageMs: number }} second
 * @returns {{ text: string, live: boolean, bad: boolean } | null}
 */
export function secondStatus({ drawn, bytes, sinceMessageMs }) {
  if (drawn > 0 || bytes > 0) {
    return { text: drawn + ' fps · ' + Math.round(bytes / 1024) + ' KB/s', live: true, bad: false };
  }
  if (sinceMessageMs < LINK.quietMs) return null;
  return { text: 'no frames for ' + Math.round(sinceMessageMs / 1000) + 's', live: false, bad: false };
}
