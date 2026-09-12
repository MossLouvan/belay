// The live, app-wide home for desktop previews.
//
// A module-level store rather than a context, for the reason attention-store.ts
// gives: the writer and the reader are in different corners of the tree and
// never share an ancestor worth threading a provider through. The screen tab's
// stream writes; the Computers list reads; neither knows the other exists.
// `useSyncExternalStore` gives that the same semantics as a context with none
// of the nesting — and, crucially, the state lives above the router, so it
// survives navigating from Screen back to Computers, which is the entire ask.
//
// The write path is deliberately two-stage. `rememberStreamFrame` is called on
// EVERY decoded frame — dozens a second — so it may not allocate a new cache
// each time. It parks the newest frame in a pending slot (one pointer write)
// and only commits, and only then notifies, at the sampling interval. `flush`
// commits whatever is parked right now, and is what the screen calls as it
// tears down: that is how the card ends up showing the exact last frame the
// user saw rather than one from a few seconds earlier.

import { useSyncExternalStore } from 'react';

import {
  EMPTY_CACHE,
  PREVIEW_LIMITS,
  base64Bytes,
  dropPreview,
  findPreview,
  maySample,
  putPreview,
  retainPreviews,
} from './preview-cache.ts';
import type { Preview, PreviewCache, PreviewSource } from './preview-cache.ts';

const JPEG_URI_PREFIX = 'data:image/jpeg;base64,';

let cache: PreviewCache = EMPTY_CACHE;
/** The newest stream frame per computer that has not been published yet. */
let pending: Readonly<Record<string, Preview>> = Object.freeze({});
/** When each computer last published, so the sampler can pace itself. */
let publishedAt: Readonly<Record<string, number>> = Object.freeze({});
let listeners: readonly (() => void)[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

/** The whole cache. Stable by identity while nothing has changed. */
export function previewCache(): PreviewCache {
  return cache;
}

/** One computer's preview, or null. */
export function previewFor(hostId: string): Preview | null {
  return findPreview(cache, hostId);
}

/**
 * Draw this computer's desktop preview, re-rendering when it changes.
 *
 * Returns null for a machine that has never been seen — the card keeps its
 * empty glyph tile, which is the correct drawing for "no picture exists",
 * not a placeholder pretending one is loading.
 */
export function useDevicePreview(hostId: string | undefined): Preview | null {
  return useSyncExternalStore(
    subscribe,
    () => (hostId ? findPreview(cache, hostId) : null),
    () => null,
  );
}

/** Commit a preview and tell everyone, unless the cache rejected it. */
function commit(next: Preview): void {
  const updated = putPreview(cache, next);
  if (updated === cache) return;
  cache = updated;
  emit();
}

/**
 * A decoded frame from the live screen stream. Called at the frame rate.
 *
 * `base64` is the raw JPEG payload the socket delivered, not a data URI: the
 * byte cost is measured from it, and the URI is built once here rather than
 * per render.
 */
export function rememberStreamFrame(hostId: string | undefined, base64: string, now = Date.now()): void {
  if (!hostId || base64.length === 0) return;
  const frame: Preview = {
    hostId,
    uri: JPEG_URI_PREFIX + base64,
    bytes: base64Bytes(base64),
    capturedAt: now,
    source: 'stream',
  };
  pending = Object.freeze({ ...pending, [hostId]: frame });
  if (!maySample(publishedAt[hostId] ?? 0, now)) return;
  publish(hostId, now);
}

/**
 * Publish whatever is parked for this computer (or for all of them).
 *
 * Called as the screen tears down, so the card shows the last frame that was
 * actually on the glass. Safe to call with nothing parked.
 */
export function flushStreamFrames(hostId?: string, now = Date.now()): void {
  const ids = hostId ? [hostId] : Object.keys(pending);
  for (const id of ids) publish(id, now);
}

function publish(hostId: string, now: number): void {
  const frame = pending[hostId];
  if (!frame) return;
  const { [hostId]: _taken, ...rest } = pending;
  pending = Object.freeze(rest);
  publishedAt = Object.freeze({ ...publishedAt, [hostId]: now });
  commit(frame);
}

/** A still fetched from a host's /screen/thumbnail. */
export function rememberHostStill(
  hostId: string,
  base64: string,
  capturedAt: number,
  source: PreviewSource = 'host',
): void {
  if (!hostId || base64.length === 0) return;
  commit({
    hostId,
    uri: JPEG_URI_PREFIX + base64,
    bytes: base64Bytes(base64),
    capturedAt,
    source,
  });
}

/** Forget one computer's desktop — what un-pairing it must do. */
export function forgetPreview(hostId: string): void {
  const { [hostId]: _dropped, ...restPending } = pending;
  pending = Object.freeze(restPending);
  const updated = dropPreview(cache, hostId);
  if (updated === cache) return;
  cache = updated;
  emit();
}

/**
 * Keep only the computers still paired.
 *
 * The list calls this whenever the device set changes, so a machine forgotten
 * from any screen in the app also loses its picture here — a cache that
 * outlives the thing it describes is how a "forgotten" computer keeps showing
 * its desktop.
 */
export function retainPairedPreviews(hostIds: readonly string[]): void {
  const updated = retainPreviews(cache, hostIds);
  if (updated === cache) return;
  cache = updated;
  emit();
}

/** Drop everything. Sign-out, un-pair-all, and the tests' reset. */
export function clearPreviews(): void {
  pending = Object.freeze({});
  publishedAt = Object.freeze({});
  if (cache === EMPTY_CACHE || cache.length === 0) { cache = EMPTY_CACHE; return; }
  cache = EMPTY_CACHE;
  emit();
}

export { PREVIEW_LIMITS };
