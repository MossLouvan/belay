// Unit tests for the stream readout.
//
//   cd app && node --test src/screen/hud.test.mjs
//
// Why this exists: the HUD read the JPEG frame counters directly, and those
// counters stop advancing the moment H.264 takes over — the host stops sending
// JPEG frames at all. A working 60fps stream therefore reported "fps 0 / 12,
// rate 0 KB/s, source —", which is indistinguishable from a dead one. These
// tests pin the thing that actually matters: a live stream never reports zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatBitrate, hudRows, isBwpLive, nowLine, qualityDescription } from './hud.ts';
import { findQuality } from './model.ts';

const quality = findQuality('balanced');

const jpegStats = {
  fps: 11,
  kbps: 340,
  frameBytes: 84_000,
  width: 1024,
  height: 576,
  sourceWidth: 1920,
  sourceHeight: 1080,
};

const idleStats = {
  fps: 0,
  kbps: 0,
  frameBytes: 0,
  width: 0,
  height: 0,
  sourceWidth: 0,
  sourceHeight: 0,
};

const base = {
  stats: jpegStats,
  bwp: null,
  bwpSize: null,
  bwpPath: null,
  quality,
  pingMs: 14,
  zoom: 1,
};

const rowMap = (rows) => Object.fromEntries(rows.map(([k, v]) => [k, v]));

test('the JPEG readout is unchanged when H.264 is not carrying video', () => {
  const r = rowMap(hudRows(base));
  assert.equal(r.fps, '11 / 12');
  assert.equal(r.rate, '340 KB/s');
  assert.equal(r.frame, '82 KB');
  assert.equal(r.sent, '1024×576');
  assert.equal(r.source, '1920×1080');
  assert.equal(r.ping, '14 ms');
  assert.equal(r.codec, undefined, 'no codec row on the JPEG path');
});

// The bug this module exists for. The JPEG counters are all zero while H.264
// runs, and reading them would report a healthy stream as a dead one.
test('a live H.264 stream never reports the stale JPEG zeros', () => {
  const rows = hudRows({
    ...base,
    stats: idleStats,
    bwp: { fps: 58.7, kbps: 1427, bitrate: 2_776_395 },
    bwpSize: { width: 1920, height: 1080 },
    bwpPath: 'gpu',
  });
  const r = rowMap(rows);
  assert.equal(r.fps, '59 / 60');
  assert.equal(r.rate, '1427 kbps');
  assert.equal(r.source, '1920×1080');
  assert.equal(r.codec, 'H.264 · GPU');
  assert.notEqual(r.fps, '0 / 12');
  assert.equal(r.sent, undefined, 'the JPEG downscale row is meaningless here');
});

// kilobits and kilobytes differ by a factor of eight. Labelling them the same
// is how a perfectly normal rate gets read as a tenfold regression.
test('the H.264 rate is labelled in bits, the JPEG rate in bytes', () => {
  const bwp = rowMap(hudRows({ ...base, bwp: { fps: 60, kbps: 1300, bitrate: 4_000_000 }, bwpPath: 'cpu' }));
  assert.match(bwp.rate, /kbps$/);
  const jpeg = rowMap(hudRows(base));
  assert.match(jpeg.rate, /KB\/s$/);
});

test('a host without a GPU is shown as plain H.264, not as GPU', () => {
  const r = rowMap(hudRows({ ...base, bwp: { fps: 28, kbps: 569, bitrate: 2_040_733 }, bwpPath: 'cpu' }));
  assert.equal(r.codec, 'H.264');
});

// The offer arrives about a second before the first stats line. Showing 0 fps
// in that gap would flash "dead stream" at the exact moment it starts working.
test('the gap between the offer and the first stats line shows dashes, not zeros', () => {
  const r = rowMap(hudRows({ ...base, stats: idleStats, bwp: null, bwpPath: 'gpu', bwpSize: null }));
  assert.equal(r.codec, 'H.264 · GPU');
  assert.equal(r.fps, '—');
  assert.equal(r.rate, '—');
  assert.notEqual(r.fps, '0 / 60');
});

test('bitrate is formatted in the largest unit that still reads naturally', () => {
  assert.equal(formatBitrate(2_776_395), '2.8 Mbps');
  assert.equal(formatBitrate(569_000), '569 kbps');
  assert.equal(formatBitrate(0), '—');
  assert.equal(formatBitrate(-1), '—');
  assert.equal(formatBitrate(NaN), '—');
});

test('isBwpLive is true from the offer, not only once stats arrive', () => {
  assert.equal(isBwpLive({ bwpPath: 'gpu', bwp: null }), true);
  assert.equal(isBwpLive({ bwpPath: null, bwp: { fps: 1, kbps: 1, bitrate: 1 } }), true);
  assert.equal(isBwpLive({ bwpPath: null, bwp: null }), false);
});

// The JPEG copy describes knobs H.264 does not have, and quotes a frame-rate
// ceiling that only existed because every JPEG frame cost full price.
test('the quality description matches the path actually in use', () => {
  const jpeg = qualityDescription(quality, false);
  assert.match(jpeg, /1024px wide/);
  assert.match(jpeg, /up to 12 fps/);

  const bwp = qualityDescription(quality, true);
  assert.match(bwp, /H\.264/);
  assert.match(bwp, /up to 60 fps/);
  assert.doesNotMatch(bwp, /1024px/, 'the downscale width is not what H.264 sends');
  assert.doesNotMatch(bwp, /quality 50/, 'JPEG quality is not a knob here');
});

test('the now-line reports whichever path is live', () => {
  assert.equal(nowLine(base), 'Now: 11 fps · 340 KB/s · ping 14 ms');
  assert.equal(
    nowLine({ ...base, stats: idleStats, bwp: { fps: 59, kbps: 1427, bitrate: 1 }, bwpPath: 'gpu' }),
    'Now: 59 fps · 1427 kbps · ping 14 ms',
  );
  assert.equal(
    nowLine({ ...base, stats: idleStats, bwp: null, bwpPath: 'gpu' }),
    'Now: starting H.264 · ping 14 ms',
  );
});

test('a missing ping shows a dash rather than null', () => {
  const r = rowMap(hudRows({ ...base, pingMs: null }));
  assert.equal(r.ping, '—');
  assert.match(nowLine({ ...base, pingMs: null }), /ping —$/);
});
