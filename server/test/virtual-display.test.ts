// Unit tests for the virtual display driver policy layer.
//
// Two failure directions matter: accepting a value the driver should never
// see (the boundary leaks), and rejecting a resolution a real client sends
// (the feature silently refuses an iPad). Every bound is tested at the edge
// on both sides, and the flag parsing mirrors the WebRTC flag's contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  virtualDisplayEnabled,
  parseVirtualDisplayRequest,
  clampVirtualDisplayRequest,
  resolveVirtualRequest,
  sameRequest,
  selectCaptureMode,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT,
  MIN_REFRESH_HZ,
  MAX_REFRESH_HZ,
  DEFAULT_REFRESH_HZ,
} from '../src/virtual-display.js';

// ---- flag ------------------------------------------------------------------

test('the flag is off by default', () => {
  assert.equal(virtualDisplayEnabled({}), false);
});

test('the flag accepts the usual truthy spellings', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
    assert.equal(virtualDisplayEnabled({ BELAY_VIRTUAL_DISPLAY: v }), true, v);
  }
});

test('the flag rejects everything else', () => {
  for (const v of ['0', 'false', 'off', 'no', '', 'enable']) {
    assert.equal(virtualDisplayEnabled({ BELAY_VIRTUAL_DISPLAY: v }), false, JSON.stringify(v));
  }
});

test('the legacy TETHER_ prefix still works, and BELAY_ wins over it', () => {
  assert.equal(virtualDisplayEnabled({ TETHER_VIRTUAL_DISPLAY: '1' }), true);
  assert.equal(
    virtualDisplayEnabled({ BELAY_VIRTUAL_DISPLAY: '0', TETHER_VIRTUAL_DISPLAY: '1' }),
    false,
  );
});

// ---- request validation ----------------------------------------------------

function parse(body: unknown) {
  return parseVirtualDisplayRequest(body);
}

test('a plain 1080p60 request parses to exactly what was asked', () => {
  const r = parse({ width: 1920, height: 1080, refreshHz: 60 });
  assert.deepEqual(r, { ok: true, request: { width: 1920, height: 1080, refreshHz: 60 } });
});

test('refreshHz defaults to 60 when absent or null', () => {
  for (const body of [{ width: 2560, height: 1440 }, { width: 2560, height: 1440, refreshHz: null }]) {
    const r = parse(body);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.request.refreshHz, DEFAULT_REFRESH_HZ);
  }
});

test('non-object bodies are rejected', () => {
  for (const body of [null, undefined, 'x', 42, [1920, 1080]]) {
    assert.equal(parse(body).ok, false, JSON.stringify(body));
  }
});

test('width and height must be integers, not numeric strings', () => {
  assert.equal(parse({ width: '1920', height: 1080 }).ok, false);
  assert.equal(parse({ width: 1920, height: '1080' }).ok, false);
  assert.equal(parse({ width: 1920.5, height: 1080 }).ok, false);
  assert.equal(parse({ width: NaN, height: 1080 }).ok, false);
  assert.equal(parse({ width: Infinity, height: 1080 }).ok, false);
  assert.equal(parse({ height: 1080 }).ok, false);
  assert.equal(parse({ width: 1920 }).ok, false);
});

test('bounds are enforced at both edges', () => {
  // Inside the bounds: accepted.
  assert.equal(parse({ width: MIN_WIDTH, height: MIN_HEIGHT }).ok, true);
  assert.equal(parse({ width: MAX_WIDTH, height: MAX_HEIGHT }).ok, true);
  // One step outside: rejected. (MIN-2/MAX+2 keeps the probe even, so the
  // rejection is provably the range check, not the parity check.)
  assert.equal(parse({ width: MIN_WIDTH - 2, height: 1080 }).ok, false);
  assert.equal(parse({ width: MAX_WIDTH + 2, height: 1080 }).ok, false);
  assert.equal(parse({ width: 1920, height: MIN_HEIGHT - 2 }).ok, false);
  assert.equal(parse({ width: 1920, height: MAX_HEIGHT + 2 }).ok, false);
});

test('odd dimensions are rejected, not rounded', () => {
  assert.equal(parse({ width: 1921, height: 1080 }).ok, false);
  assert.equal(parse({ width: 1920, height: 1081 }).ok, false);
});

test('refreshHz bounds are enforced and strings rejected', () => {
  assert.equal(parse({ width: 1920, height: 1080, refreshHz: MIN_REFRESH_HZ }).ok, true);
  assert.equal(parse({ width: 1920, height: 1080, refreshHz: MAX_REFRESH_HZ }).ok, true);
  assert.equal(parse({ width: 1920, height: 1080, refreshHz: MIN_REFRESH_HZ - 1 }).ok, false);
  assert.equal(parse({ width: 1920, height: 1080, refreshHz: MAX_REFRESH_HZ + 1 }).ok, false);
  assert.equal(parse({ width: 1920, height: 1080, refreshHz: '60' }).ok, false);
  assert.equal(parse({ width: 1920, height: 1080, refreshHz: 59.94 }).ok, false);
});

test('rejections carry a human-readable reason', () => {
  const r = parse({ width: 100, height: 1080 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /width/);
});

// ---- phone-driven config path: clamp, resolve, select ----------------------
//
// The REST route rejects; the live `config` path CLAMPS, so a phone's logical
// size a hair off the bounds nudges to a valid mode instead of dropping the
// stream. These are the pure decisions the index.ts lifecycle is a thin shell
// around, so they carry the real coverage.

test('clamp keeps an in-range, even 1080p request exactly', () => {
  assert.deepEqual(
    clampVirtualDisplayRequest({ width: 1920, height: 1080, refreshHz: 60 }),
    { width: 1920, height: 1080, refreshHz: 60 },
  );
});

test('clamp forces even dimensions (encoder requirement)', () => {
  const r = clampVirtualDisplayRequest({ width: 1179, height: 2555 });
  assert.equal(r?.width, 1180);
  assert.equal(r?.height, 2556);
});

test('clamp pins dimensions and refresh to the bounds instead of rejecting', () => {
  const low = clampVirtualDisplayRequest({ width: 1, height: 1, refreshHz: 1 });
  assert.deepEqual(low, { width: MIN_WIDTH, height: MIN_HEIGHT, refreshHz: MIN_REFRESH_HZ });
  const high = clampVirtualDisplayRequest({ width: 99999, height: 99999, refreshHz: 99999 });
  assert.deepEqual(high, { width: MAX_WIDTH, height: MAX_HEIGHT, refreshHz: MAX_REFRESH_HZ });
});

test('clamp defaults refresh to 60 when absent', () => {
  assert.equal(clampVirtualDisplayRequest({ width: 1280, height: 800 })?.refreshHz, DEFAULT_REFRESH_HZ);
});

test('clamp returns null for a body without usable width/height', () => {
  for (const body of [null, undefined, 'x', 42, [1280, 800], {}, { width: 1280 }, { width: '1280', height: 800 }]) {
    assert.equal(clampVirtualDisplayRequest(body), null, JSON.stringify(body));
  }
});

test('resolveVirtualRequest is three-state: keep / clear / replace', () => {
  const current = { width: 1280, height: 800, refreshHz: 60 };
  // absent field -> keep whatever the stream had
  assert.equal(resolveVirtualRequest({}, current), current);
  assert.equal(resolveVirtualRequest({ virtualDisplay: undefined }, current), current);
  // explicit null -> back to the physical screen
  assert.equal(resolveVirtualRequest({ virtualDisplay: null }, current), null);
  // object -> a new clamped request
  assert.deepEqual(
    resolveVirtualRequest({ virtualDisplay: { width: 1920, height: 1200 } }, current),
    { width: 1920, height: 1200, refreshHz: 60 },
  );
});

test('resolveVirtualRequest falls back to physical when the object is unusable', () => {
  assert.equal(resolveVirtualRequest({ virtualDisplay: { width: 'x' } }, null), null);
});

test('sameRequest compares by value and treats null as physical', () => {
  const a = { width: 1280, height: 800, refreshHz: 60 };
  assert.equal(sameRequest(a, { width: 1280, height: 800, refreshHz: 60 }), true);
  assert.equal(sameRequest(a, { width: 1280, height: 800, refreshHz: 30 }), false);
  assert.equal(sameRequest(null, null), true);
  assert.equal(sameRequest(a, null), false);
  assert.equal(sameRequest(null, a), false);
});

test('selectCaptureMode is the fallback gate: virtual only when the host has it', () => {
  const req = { width: 1280, height: 800, refreshHz: 60 };
  assert.deepEqual(selectCaptureMode(req, true), { virtual: req });
  // Requested but the host cannot: fall back to the physical downscale.
  assert.deepEqual(selectCaptureMode(req, false), { virtual: null });
  // No request: physical regardless.
  assert.deepEqual(selectCaptureMode(null, true), { virtual: null });
});
