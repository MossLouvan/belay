// The picture of each computer's desktop that the Computers list draws on its
// cards — as data, with no React and no networking, so every rule below is
// unit-testable.
//
// What a preview is. One JPEG data URI per computer, keyed on the host id
// (never a URL — a machine's address changes and its id does not, which is the
// same reason the device store is keyed that way). It arrives from one of two
// places: `stream`, the last frame the user actually saw before tapping back,
// and `host`, a still fetched from that computer's /screen/thumbnail. A stream
// frame is the better picture — it is literally what was on screen a moment
// ago — so it is never quietly replaced by an older host still.
//
// Why it is bounded. A preview is a photograph of somebody's desktop held in
// this phone's RAM. Two caps, both hard: a per-entry ceiling so one enormous
// frame cannot become the cache, and a whole-cache byte budget so a user with
// eight paired machines does not carry eight desktops around. Eviction is
// least-recently-written, which for this data is the same as least-recently-
// seen: entries are only ever written, never touched on read.
//
// Why it is NOT persisted. Deliberate, and the interesting decision here.
// Writing these to disk would survive an app restart, which sounds like a
// feature until you say what it actually means: a picture of the owner's
// desktop — whatever was open, a password manager, a DM, a bank tab — sitting
// in the app container indefinitely, readable by anything that can read the
// container and by anyone holding an unlocked phone, long after it stopped
// being true. The ask was "when I go back, show me what I was just looking
// at": that is a navigation-lifetime need, and in-memory state already
// survives navigating between tabs, which is the whole of it. A cold start
// has no "just looking at" to restore, and a connected machine re-fetches a
// current still in well under a second — so persistence would buy staleness
// and a standing privacy liability in exchange for nothing.

/** Where a preview came from. Ranked: a live frame always beats a fetched still. */
export type PreviewSource = 'stream' | 'host';

export interface Preview {
  /** Host id — the same primary key the device store uses. */
  readonly hostId: string;
  /** `data:image/jpeg;base64,…`, ready for an <Image source={{uri}}>. */
  readonly uri: string;
  /** Decoded JPEG size, the number the byte budget is spent in. */
  readonly bytes: number;
  /** When the picture was taken (epoch ms), for ageing it out. */
  readonly capturedAt: number;
  readonly source: PreviewSource;
}

/** Every bound the cache lives inside. */
export const PREVIEW_LIMITS = Object.freeze({
  /** Computers remembered at once. More than anyone pairs; still finite. */
  maxEntries: 6,
  /** Whole-cache budget. Six 320px desktop stills are well under this. */
  maxBytes: 2 * 1024 * 1024,
  /** One preview's ceiling. Mirrors the host route's own cap. */
  maxEntryBytes: 256 * 1024,
  /** A preview older than this is drawn, but is also worth replacing. */
  staleAfterMs: 60_000,
  /** How often a live stream is allowed to publish a new card preview. */
  sampleMs: 4_000,
} as const);

export interface PreviewLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
}

/** The cache, most-recently-written first. Always a new array; never mutated. */
export type PreviewCache = readonly Preview[];

export const EMPTY_CACHE: PreviewCache = Object.freeze([]);

/** The preview for one computer, or null when there has never been one. */
export function findPreview(cache: PreviewCache, hostId: string): Preview | null {
  return cache.find((p) => p.hostId === hostId) ?? null;
}

/**
 * Whether `next` is worth storing over what is already held.
 *
 * Two rules, in order:
 *   - A live stream frame always wins. It is what the user was looking at.
 *   - Otherwise the newer picture wins. A host still that raced an older one
 *     home out of order must not overwrite the fresher answer.
 *
 * The stream rule has a deliberate escape: a stream frame more than
 * `staleAfterMs` old is no longer "what you were just looking at", so a fresh
 * host still may replace it. Without that, opening a machine once would pin
 * that moment onto its card for the rest of the session.
 */
export function supersedes(next: Preview, current: Preview | null, staleAfterMs = PREVIEW_LIMITS.staleAfterMs): boolean {
  if (!current) return true;
  if (next.capturedAt <= current.capturedAt) return false;
  if (next.source === 'stream') return true;
  const currentIsFreshStream =
    current.source === 'stream' && next.capturedAt - current.capturedAt < staleAfterMs;
  return !currentIsFreshStream;
}

/**
 * Store a preview, returning a new cache.
 *
 * Returns the cache unchanged — by identity, so a `useSyncExternalStore`
 * subscriber does not re-render — when the entry is rejected for being over
 * the per-entry ceiling, or when what is already held is the better picture.
 */
export function putPreview(cache: PreviewCache, next: Preview, limits: PreviewLimits = {}): PreviewCache {
  const maxEntries = limits.maxEntries ?? PREVIEW_LIMITS.maxEntries;
  const maxBytes = limits.maxBytes ?? PREVIEW_LIMITS.maxBytes;
  const maxEntryBytes = limits.maxEntryBytes ?? PREVIEW_LIMITS.maxEntryBytes;

  if (next.bytes <= 0 || next.bytes > maxEntryBytes) return cache;
  if (next.uri.length === 0) return cache;
  if (!supersedes(next, findPreview(cache, next.hostId))) return cache;

  const others = cache.filter((p) => p.hostId !== next.hostId);
  return evict([next, ...others], maxEntries, maxBytes);
}

/** Drop every trace of one computer — what `forget this computer` must do. */
export function dropPreview(cache: PreviewCache, hostId: string): PreviewCache {
  const kept = cache.filter((p) => p.hostId !== hostId);
  return kept.length === cache.length ? cache : kept;
}

/**
 * Keep only the computers that are still paired.
 *
 * Called whenever the device list changes, so forgetting a machine anywhere in
 * the app takes its desktop out of memory too, rather than leaving it held by
 * a cache nobody thought to tell.
 */
export function retainPreviews(cache: PreviewCache, hostIds: readonly string[]): PreviewCache {
  const live = new Set(hostIds);
  const kept = cache.filter((p) => live.has(p.hostId));
  return kept.length === cache.length ? cache : kept;
}

/** Trim the tail (oldest writes) until both caps hold. */
function evict(cache: PreviewCache, maxEntries: number, maxBytes: number): PreviewCache {
  let kept = cache.slice(0, Math.max(1, maxEntries));
  // Never evict down to nothing: the head is the entry just written, and a
  // budget smaller than one preview should cost the cache its history, not the
  // picture the caller just asked to show.
  while (kept.length > 1 && total(kept) > maxBytes) kept = kept.slice(0, kept.length - 1);
  return kept;
}

function total(cache: PreviewCache): number {
  return cache.reduce((sum, p) => sum + p.bytes, 0);
}

/** Whole-cache footprint, for tests and for anyone reasoning about memory. */
export function cacheBytes(cache: PreviewCache): number {
  return total(cache);
}

/**
 * Whether a live stream may publish another card preview yet.
 *
 * The stream delivers 30-60 frames a second and the card needs one every few
 * seconds, so all but a handful are dropped before they ever reach the store.
 * `lastAt` of 0 means "nothing published for this computer yet", which always
 * passes: the first frame should reach the card immediately.
 */
export function maySample(lastAt: number, now: number, sampleMs = PREVIEW_LIMITS.sampleMs): boolean {
  if (lastAt <= 0) return true;
  return now - lastAt >= sampleMs;
}

/**
 * Whether a computer's card is worth spending a host capture on.
 *
 * Only ever true for a machine that just answered a reachability probe, so the
 * app never photographs a desktop it merely hopes is there. Beyond that it is
 * the freshness rule: no picture at all, or one old enough to be misleading.
 */
export function needsHostStill(
  capturedAt: number | null,
  now: number,
  staleAfterMs = PREVIEW_LIMITS.staleAfterMs,
): boolean {
  if (capturedAt === null) return true;
  return now - capturedAt >= staleAfterMs;
}

/** Decoded byte length of a base64 payload, without allocating it. */
export function base64Bytes(base64: string): number {
  const n = base64.length;
  if (n === 0) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((n * 3) / 4) - padding;
}
