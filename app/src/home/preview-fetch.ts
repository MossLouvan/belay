// Asking one computer for a still of its desktop.
//
// Its own module, and its own deadline, rather than a helper on api.ts: every
// other request in the app goes through the ONE connection the app currently
// holds, and this one deliberately does not. A card wants a picture of a
// machine the phone is not connected to — the other laptop, sitting on the
// list — so the address and the bearer token are passed in from that saved
// computer's own record. The ten-second app-wide deadline is also wrong here:
// a thumbnail that has not arrived in a few seconds has already missed the
// glance it was for, and hanging on would only hold a card in limbo.
//
// Everything the host can say short of a picture — 401 (un-paired), 429 (asked
// too often), 503 (no capture, no permission, desktop locked) — is one answer
// to this caller: null, meaning "the card keeps its empty tile". None of them
// is worth a toast: the user did not ask for this, and there is nothing to do
// about it.

/** Short on purpose — see the module note. */
export const STILL_TIMEOUT_MS = 6_000;

/**
 * Ceiling on the base64 payload accepted, independent of the host's own cap.
 *
 * The host bounds what it sends; this bounds what this phone is willing to
 * hold, so a host that is old, modified or simply wrong cannot push an
 * arbitrarily large picture into the app's memory. 512 KB of base64 is ~384 KB
 * of JPEG, comfortably above a 320px desktop and far below anything alarming.
 */
export const MAX_STILL_BASE64 = 512 * 1024;

export interface HostStill {
  /** Raw base64 JPEG, exactly as the host sent it. */
  readonly data: string;
  /** When the host says it took the picture, for ageing it out. */
  readonly capturedAt: number;
}

/** Everything this module needs from a saved computer. */
export interface StillTarget {
  readonly url: string;
  readonly token: string;
}

/**
 * Fetch one still, or null for every failure.
 *
 * `signal` is honoured alongside the deadline so a caller unmounting — the
 * user leaving the Computers tab mid-flight — actually cancels the request
 * rather than abandoning it to resolve into a store nobody is watching.
 */
export async function fetchHostStill(
  target: StillTarget,
  signal?: AbortSignal,
  timeoutMs = STILL_TIMEOUT_MS,
): Promise<HostStill | null> {
  // A signal that is ALREADY aborted fires no event, so subscribing to it
  // would silently start the request anyway — and a caller who has left the
  // screen would still have photographed the desktop.
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${target.url}/screen/thumbnail`, {
      method: 'GET',
      headers: { authorization: `Bearer ${target.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseHostStill(await res.json());
  } catch {
    // A cancelled fetch, a dead address, a host that answered something that
    // is not JSON — all of it is "no picture", and none of it is this
    // module's to explain.
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Validate an answer from the host before a single byte of it is believed.
 *
 * The body is untrusted data from the network, so `data` is checked for shape
 * and size, and `capturedAt` is only accepted as a sane epoch-ms number —
 * a garbage timestamp would otherwise pin a picture as permanently fresh (or
 * permanently stale) in the cache's ageing rules.
 */
export function parseHostStill(body: unknown, now = Date.now()): HostStill | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const data = raw.data;
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_STILL_BASE64) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const capturedAt = typeof raw.capturedAt === 'number' && Number.isFinite(raw.capturedAt)
    ? raw.capturedAt
    : now;
  // The host's clock is its own. A timestamp from the future, or from before
  // this app existed, is not a reason to reject a good picture — but it is a
  // reason not to let it drive the ageing rules, so it is clamped to now.
  const sane = capturedAt > 0 && capturedAt <= now + 60_000 ? Math.min(capturedAt, now) : now;
  return { data, capturedAt: sane };
}
