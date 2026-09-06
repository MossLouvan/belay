// Tests for the live-state rule and the complete-line splitter behind the
// transcript tail. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_WINDOW_MS, completeLines, isLive, liveUntil } from '../src/session-live.js';

// ---- isLive ----------------------------------------------------------------

test('isLive is true inside the window and false at its edge', () => {
  const now = 1_000_000;
  assert.equal(isLive(now, now), true);
  assert.equal(isLive(now - LIVE_WINDOW_MS + 1, now), true);
  assert.equal(isLive(now - LIVE_WINDOW_MS, now), false);
  assert.equal(isLive(now - LIVE_WINDOW_MS * 10, now), false);
});

test('isLive treats an unknown or absurd write time as quiet', () => {
  assert.equal(isLive(undefined, 5), false);
  assert.equal(isLive(Number.NaN, 5), false);
  assert.equal(isLive(Number.POSITIVE_INFINITY, 5), false);
  // A write "from the future" (clock skew) is not live either.
  assert.equal(isLive(10_000, 5_000), false);
});

test('isLive honours a custom window', () => {
  assert.equal(isLive(0, 999, 1000), true);
  assert.equal(isLive(0, 1000, 1000), false);
});

test('LIVE_WINDOW_MS is the documented 90 seconds', () => {
  assert.equal(LIVE_WINDOW_MS, 90_000);
});

// ---- liveUntil -------------------------------------------------------------

test('liveUntil is lastWriteAt plus the window, or null when unknown', () => {
  assert.equal(liveUntil(100), 100 + LIVE_WINDOW_MS);
  assert.equal(liveUntil(100, 5), 105);
  assert.equal(liveUntil(undefined), null);
  assert.equal(liveUntil(Number.NaN), null);
});

// ---- completeLines ---------------------------------------------------------

test('completeLines returns whole lines and the bytes they consumed', () => {
  const buf = Buffer.from('{"a":1}\n{"b":2}\n');
  const { lines, consumed } = completeLines(buf);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(consumed, buf.length);
});

test('completeLines leaves a trailing partial line for the next read', () => {
  const head = '{"a":1}\n';
  const buf = Buffer.from(head + '{"b":');
  const { lines, consumed } = completeLines(buf);
  assert.deepEqual(lines, ['{"a":1}']);
  assert.equal(consumed, Buffer.byteLength(head));
});

test('completeLines consumes nothing when no newline has arrived', () => {
  assert.deepEqual(completeLines(Buffer.from('{"partial')), { lines: [], consumed: 0 });
  assert.deepEqual(completeLines(Buffer.alloc(0)), { lines: [], consumed: 0 });
});

test('completeLines drops blank lines and CRLF but counts their bytes', () => {
  const buf = Buffer.from('{"a":1}\r\n\n{"b":2}\r\n');
  const { lines, consumed } = completeLines(buf);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(consumed, buf.length);
});

test('completeLines counts bytes, not characters, for multibyte text', () => {
  const buf = Buffer.from('{"t":"héllo — ✓"}\n{"x');
  const { lines, consumed } = completeLines(buf);
  assert.deepEqual(lines, ['{"t":"héllo — ✓"}']);
  assert.equal(consumed, Buffer.byteLength('{"t":"héllo — ✓"}\n'));
  assert.equal(buf.subarray(consumed).toString(), '{"x');
});
