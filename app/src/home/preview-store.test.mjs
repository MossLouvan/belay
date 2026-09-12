// Tests for the app-wide preview store: the frame-rate write path, the
// sampler, the teardown flush that makes "go back and see what you were just
// looking at" exact, and the notify contract `useSyncExternalStore` depends on.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PREVIEW_LIMITS } from './preview-cache.ts';
import {
  clearPreviews,
  flushStreamFrames,
  forgetPreview,
  previewCache,
  previewFor,
  rememberHostStill,
  rememberStreamFrame,
  retainPairedPreviews,
} from './preview-store.ts';

/** A distinguishable base64 payload of a given length. */
const jpeg = (marker, length = 64) => Buffer.alloc(length, marker.charCodeAt(0)).toString('base64');

test('a stream frame becomes this computer\'s preview immediately', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  const preview = previewFor('mac');
  assert.ok(preview);
  assert.equal(preview.source, 'stream');
  assert.equal(preview.capturedAt, 1000);
  assert.match(preview.uri, /^data:image\/jpeg;base64,/);
});

test('frames inside the sampling interval are held back, not published', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  rememberStreamFrame('mac', jpeg('b'), 1500);
  rememberStreamFrame('mac', jpeg('c'), 2000);
  // Still the first one: 30 frames a second must not be 30 cache writes.
  assert.equal(previewFor('mac').capturedAt, 1000);
});

test('a frame past the sampling interval publishes', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  rememberStreamFrame('mac', jpeg('b'), 1000 + PREVIEW_LIMITS.sampleMs);
  assert.equal(previewFor('mac').capturedAt, 1000 + PREVIEW_LIMITS.sampleMs);
});

test('flush publishes the newest held frame regardless of the sampler', () => {
  // This is the founder's ask: the card shows the frame that was on the glass
  // when he tapped back, not one from a few seconds earlier.
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  rememberStreamFrame('mac', jpeg('z'), 1200);
  flushStreamFrames('mac', 1200);
  const preview = previewFor('mac');
  assert.equal(preview.capturedAt, 1200);
  assert.equal(preview.uri, `data:image/jpeg;base64,${jpeg('z')}`);
});

test('flush with nothing held is a no-op, and keeps what was published', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  flushStreamFrames('mac', 1100);
  flushStreamFrames('mac', 1200);
  assert.equal(previewFor('mac').capturedAt, 1000);
});

test('flush with no host id publishes every computer holding a frame', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  rememberStreamFrame('pc', jpeg('b'), 1000);
  rememberStreamFrame('mac', jpeg('c'), 1100);
  rememberStreamFrame('pc', jpeg('d'), 1100);
  flushStreamFrames(undefined, 1100);
  assert.equal(previewFor('mac').capturedAt, 1100);
  assert.equal(previewFor('pc').capturedAt, 1100);
});

test('a stream frame with no host id is dropped rather than mis-keyed', () => {
  // The connection can be resolving; a frame that cannot say which computer it
  // came from must not be filed under a guess.
  clearPreviews();
  rememberStreamFrame(undefined, jpeg('a'), 1000);
  assert.equal(previewCache().length, 0);
});

test('an empty payload is dropped', () => {
  clearPreviews();
  rememberStreamFrame('mac', '', 1000);
  assert.equal(previewCache().length, 0);
});

test('a host still fills a card for a computer never opened', () => {
  clearPreviews();
  rememberHostStill('pc', jpeg('a'), 5000);
  const preview = previewFor('pc');
  assert.ok(preview);
  assert.equal(preview.source, 'host');
  assert.equal(preview.capturedAt, 5000);
});

test('a host still does not clobber the frame just seen on that computer', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('s'), 1000);
  rememberHostStill('mac', jpeg('h'), 1500);
  assert.equal(previewFor('mac').source, 'stream');
});

test('forgetPreview removes the computer\'s desktop from memory', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  forgetPreview('mac');
  assert.equal(previewFor('mac'), null);
});

test('forgetPreview also discards a frame held but not yet published', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  rememberStreamFrame('mac', jpeg('b'), 1100);
  forgetPreview('mac');
  flushStreamFrames('mac', 1200);
  assert.equal(previewFor('mac'), null, 'a flush must not resurrect a forgotten desktop');
});

test('retainPairedPreviews drops computers that are no longer paired', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  rememberStreamFrame('pc', jpeg('b'), 1000);
  retainPairedPreviews(['pc']);
  assert.equal(previewFor('mac'), null);
  assert.ok(previewFor('pc'));
});

test('the cache is bounded across many computers', () => {
  clearPreviews();
  for (let i = 0; i < PREVIEW_LIMITS.maxEntries + 4; i += 1) {
    rememberHostStill(`host-${i}`, jpeg('a'), 1000 + i);
  }
  assert.equal(previewCache().length, PREVIEW_LIMITS.maxEntries);
});

// ---- the notify contract -------------------------------------------------

test('the cache snapshot is stable by identity when nothing changed', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  const before = previewCache();
  // Held back by the sampler: no write, so no new snapshot and no re-render.
  rememberStreamFrame('mac', jpeg('b'), 1001);
  assert.equal(previewCache(), before);
});

test('a rejected write does not produce a new snapshot', () => {
  clearPreviews();
  rememberHostStill('mac', jpeg('a'), 5000);
  const before = previewCache();
  rememberHostStill('mac', jpeg('b'), 4000); // older; refused
  assert.equal(previewCache(), before);
});

test('clearPreviews empties the store and the pending frames with it', () => {
  clearPreviews();
  rememberStreamFrame('mac', jpeg('a'), 1000);
  rememberStreamFrame('mac', jpeg('b'), 1100);
  clearPreviews();
  flushStreamFrames(undefined, 1200);
  assert.equal(previewCache().length, 0);
});
