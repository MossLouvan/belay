// Tests for the desktop-preview cache: keying, the stream-beats-still rule,
// both eviction caps, and the two pacing predicates. Pure data, no React and
// no network. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_CACHE,
  PREVIEW_LIMITS,
  base64Bytes,
  cacheBytes,
  dropPreview,
  findPreview,
  maySample,
  needsHostStill,
  putPreview,
  retainPreviews,
  supersedes,
} from './preview-cache.ts';

const preview = (hostId, over = {}) => ({
  hostId,
  uri: `data:image/jpeg;base64,${'A'.repeat(64)}`,
  bytes: 1024,
  capturedAt: 1000,
  source: 'host',
  ...over,
});

// ---- keying --------------------------------------------------------------

test('previews are keyed on host id, never on address', () => {
  const cache = putPreview(EMPTY_CACHE, preview('mac'));
  assert.equal(findPreview(cache, 'mac')?.hostId, 'mac');
  assert.equal(findPreview(cache, 'pc'), null);
});

test('a second picture of the same computer replaces it rather than adding one', () => {
  let cache = putPreview(EMPTY_CACHE, preview('mac', { capturedAt: 1000 }));
  cache = putPreview(cache, preview('mac', { capturedAt: 2000 }));
  assert.equal(cache.length, 1);
  assert.equal(findPreview(cache, 'mac').capturedAt, 2000);
});

test('two computers keep two independent pictures', () => {
  let cache = putPreview(EMPTY_CACHE, preview('mac'));
  cache = putPreview(cache, preview('pc'));
  assert.equal(cache.length, 2);
  assert.ok(findPreview(cache, 'mac'));
  assert.ok(findPreview(cache, 'pc'));
});

// ---- which picture wins --------------------------------------------------

test('an older picture never overwrites a newer one', () => {
  const cache = putPreview(EMPTY_CACHE, preview('mac', { capturedAt: 5000 }));
  const after = putPreview(cache, preview('mac', { capturedAt: 4000 }));
  assert.equal(after, cache, 'the cache should be unchanged by identity');
});

test('a live stream frame outranks a host still taken at the same moment', () => {
  const still = preview('mac', { capturedAt: 1000, source: 'host' });
  const frame = preview('mac', { capturedAt: 1001, source: 'stream' });
  assert.equal(supersedes(frame, still), true);
});

test('a fresh stream frame is not replaced by a newer host still', () => {
  // The founder's literal ask: after going back, the card keeps showing the
  // view he just had — a background refresh must not overwrite it seconds later.
  const frame = preview('mac', { capturedAt: 1000, source: 'stream' });
  const still = preview('mac', { capturedAt: 1000 + PREVIEW_LIMITS.staleAfterMs - 1, source: 'host' });
  assert.equal(supersedes(still, frame), false);
});

test('a stale stream frame IS replaced by a fresh host still', () => {
  // …but it must not be pinned there forever, or opening a machine once would
  // freeze that moment onto its card for the rest of the session.
  const frame = preview('mac', { capturedAt: 1000, source: 'stream' });
  const still = preview('mac', { capturedAt: 1000 + PREVIEW_LIMITS.staleAfterMs, source: 'host' });
  assert.equal(supersedes(still, frame), true);
});

// ---- eviction ------------------------------------------------------------

test('eviction: the entry count is capped, oldest write first', () => {
  let cache = EMPTY_CACHE;
  for (let i = 0; i < 4; i += 1) {
    cache = putPreview(cache, preview(`host-${i}`, { capturedAt: 1000 + i }), { maxEntries: 3 });
  }
  assert.equal(cache.length, 3);
  assert.equal(findPreview(cache, 'host-0'), null, 'the oldest write should be gone');
  assert.ok(findPreview(cache, 'host-3'));
});

test('eviction: the byte budget is capped, oldest write first', () => {
  let cache = EMPTY_CACHE;
  for (const id of ['a', 'b', 'c']) {
    cache = putPreview(cache, preview(id, { bytes: 400, capturedAt: 1000 }), { maxBytes: 1000 });
  }
  assert.ok(cacheBytes(cache) <= 1000, `cache held ${cacheBytes(cache)} bytes`);
  assert.equal(cache.length, 2);
  assert.equal(findPreview(cache, 'a'), null);
  assert.ok(findPreview(cache, 'c'), 'the picture just written must survive');
});

test('eviction: re-writing a computer refreshes its place in the queue', () => {
  let cache = EMPTY_CACHE;
  cache = putPreview(cache, preview('a', { capturedAt: 1 }), { maxEntries: 2 });
  cache = putPreview(cache, preview('b', { capturedAt: 2 }), { maxEntries: 2 });
  cache = putPreview(cache, preview('a', { capturedAt: 3 }), { maxEntries: 2 });
  cache = putPreview(cache, preview('c', { capturedAt: 4 }), { maxEntries: 2 });
  // 'b' is now the oldest write, not 'a'.
  assert.equal(findPreview(cache, 'b'), null);
  assert.ok(findPreview(cache, 'a'));
  assert.ok(findPreview(cache, 'c'));
});

test('eviction: a budget smaller than one picture still keeps the newest one', () => {
  const cache = putPreview(EMPTY_CACHE, preview('a', { bytes: 5000 }), { maxBytes: 100 });
  assert.equal(cache.length, 1, 'never evict down to nothing');
});

test('a picture over the per-entry ceiling is refused outright', () => {
  const cache = putPreview(EMPTY_CACHE, preview('a', { bytes: PREVIEW_LIMITS.maxEntryBytes + 1 }));
  assert.equal(cache, EMPTY_CACHE);
});

test('an empty or zero-byte picture is refused', () => {
  assert.equal(putPreview(EMPTY_CACHE, preview('a', { bytes: 0 })), EMPTY_CACHE);
  assert.equal(putPreview(EMPTY_CACHE, preview('a', { uri: '' })), EMPTY_CACHE);
});

// ---- forgetting ----------------------------------------------------------

test('dropPreview removes exactly one computer and nothing else', () => {
  let cache = putPreview(EMPTY_CACHE, preview('mac'));
  cache = putPreview(cache, preview('pc'));
  const after = dropPreview(cache, 'mac');
  assert.equal(after.length, 1);
  assert.ok(findPreview(after, 'pc'));
});

test('dropPreview on an unknown computer changes nothing, by identity', () => {
  const cache = putPreview(EMPTY_CACHE, preview('mac'));
  assert.equal(dropPreview(cache, 'nope'), cache);
});

test('retainPreviews drops every computer that is no longer paired', () => {
  let cache = putPreview(EMPTY_CACHE, preview('mac'));
  cache = putPreview(cache, preview('pc'));
  const after = retainPreviews(cache, ['pc']);
  assert.equal(after.length, 1);
  assert.equal(findPreview(after, 'mac'), null);
});

test('retainPreviews with the same paired set changes nothing, by identity', () => {
  const cache = putPreview(EMPTY_CACHE, preview('mac'));
  assert.equal(retainPreviews(cache, ['mac']), cache);
});

// ---- pacing --------------------------------------------------------------

test('maySample lets the first frame straight through', () => {
  assert.equal(maySample(0, 123456), true);
});

test('maySample holds frames back until the sampling interval has passed', () => {
  assert.equal(maySample(1000, 1000 + PREVIEW_LIMITS.sampleMs - 1), false);
  assert.equal(maySample(1000, 1000 + PREVIEW_LIMITS.sampleMs), true);
});

test('needsHostStill is true only with no picture or a stale one', () => {
  assert.equal(needsHostStill(null, 10_000), true);
  assert.equal(needsHostStill(10_000 - PREVIEW_LIMITS.staleAfterMs + 1, 10_000), false);
  assert.equal(needsHostStill(10_000 - PREVIEW_LIMITS.staleAfterMs, 10_000), true);
});

test('base64Bytes measures the decoded length, padding included', () => {
  for (const n of [1, 2, 3, 64, 1023]) {
    assert.equal(base64Bytes(Buffer.alloc(n, 9).toString('base64')), n);
  }
  assert.equal(base64Bytes(''), 0);
});
