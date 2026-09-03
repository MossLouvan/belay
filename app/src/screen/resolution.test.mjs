// Unit tests for the true-resolution (virtual display) selection helpers and
// the `config` wire message that carries the chosen mode to the host.
//
//   cd app && node --test src/screen/resolution.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.
//
// Why this exists: the NEW resolution axis is the one place the phone tells the
// host to render at a different SHAPE, and shaping the message wrong (dropping
// `virtualDisplay`, or sending an odd/absent size) is exactly what strands a
// stream on the wrong display or refuses an aspect-matched picture. These are
// the pure decisions the screen tab and the socket are thin shells around.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHYSICAL_RESOLUTION,
  PHYSICAL_RESOLUTION_ID,
  RESOLUTION_PRESETS,
  VIRTUAL_REFRESH_HZ,
  toEven,
  matchDeviceResolution,
  resolutionOptions,
  virtualRequestFor,
  findResolution,
  buildConfigMessage,
} from './model.ts';

// buildConfigMessage is defined in model.ts (re-exported by stream.ts).

const quality = { id: 'balanced', label: 'Balanced', w: 1024, q: 50, fps: 12, hint: '' };

// ---- resolution options ----------------------------------------------------

test('physical is always the first option and maps to no virtual request', () => {
  const opts = resolutionOptions({ w: 0, h: 0 });
  assert.equal(opts[0].id, PHYSICAL_RESOLUTION_ID);
  assert.equal(virtualRequestFor(PHYSICAL_RESOLUTION), null);
});

test('an unknown device size hides "Match my phone" but keeps the presets', () => {
  const opts = resolutionOptions({ w: 0, h: 0 });
  assert.equal(opts.find((o) => o.id === 'match'), undefined);
  // physical + the two fixed presets
  assert.equal(opts.length, 1 + RESOLUTION_PRESETS.length);
});

test('a known device size adds an even, aspect-exact "Match my phone"', () => {
  // An odd logical size, as real devices report (e.g. an iPhone's 1179).
  const match = matchDeviceResolution({ w: 1179, h: 2555 });
  assert.ok(match);
  assert.equal(match.id, 'match');
  // Rounded to even for the encoder.
  assert.deepEqual(match.size, { w: 1180, h: 2556 });
});

test('resolutionOptions orders physical, match, then presets', () => {
  const ids = resolutionOptions({ w: 1280, h: 800 }).map((o) => o.id);
  assert.deepEqual(ids, ['physical', 'match', ...RESOLUTION_PRESETS.map((p) => p.id)]);
});

test('toEven rounds to the nearest even integer', () => {
  assert.equal(toEven(1179), 1180);
  assert.equal(toEven(1280), 1280);
  assert.equal(toEven(802), 802);
  assert.equal(toEven(803), 804);
});

test('virtualRequestFor carries an even size at the standard refresh', () => {
  const req = virtualRequestFor({ id: '1280x800', label: '', hint: '', size: { w: 1280, h: 800 } });
  assert.deepEqual(req, { width: 1280, height: 800, refreshHz: VIRTUAL_REFRESH_HZ });
});

test('findResolution falls back to physical for an id no longer in the menu', () => {
  const opts = resolutionOptions({ w: 0, h: 0 });
  assert.equal(findResolution('match', opts).id, 'physical');
  assert.equal(findResolution('1920x1200', opts).id, '1920x1200');
});

// ---- config message --------------------------------------------------------

test('config always carries virtualDisplay so the mode is never ambiguous', () => {
  const physical = buildConfigMessage(quality, undefined, null);
  assert.deepEqual(physical, { type: 'config', w: 1024, q: 50, fps: 12, virtualDisplay: null });

  const virtual = buildConfigMessage(quality, 2, { width: 1180, height: 2556, refreshHz: 60 });
  assert.deepEqual(virtual, {
    type: 'config', w: 1024, q: 50, fps: 12, screen: 2,
    virtualDisplay: { width: 1180, height: 2556, refreshHz: 60 },
  });
});

test('config omits screen (not null) when no monitor is chosen', () => {
  const msg = buildConfigMessage(quality, undefined, null);
  assert.equal('screen' in msg, false);
  // A real monitor index survives, including 0.
  assert.equal(buildConfigMessage(quality, 0, null).screen, 0);
});
