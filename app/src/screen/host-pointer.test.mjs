// The host's real pointer, drawn by the phone over an H.264 picture.
//
//   cd app && node --test src/screen/host-pointer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POINTER_SCALE, parsePointerMessage, placePointer } from './host-pointer.ts';
import { h264CaptureWidth } from './model.ts';

const arrow = { png: 'iVBORw0KGgo=', w: 28, h: 40, hx: 5, hy: 5 };

// ---- capture width on the H.264 path ----------------------------------------

test('balanced asks for the phone screen in pixels, not the JPEG 1024', () => {
  // iPhone 15: 852pt × 3 = 2556 px on the long side.
  assert.equal(h264CaptureWidth('balanced', 2556, 3420), 2556);
  assert.equal(h264CaptureWidth('performance', 2556, 3420), 2556);
});

test('sharp and ultra ask for the source, up to 2560', () => {
  assert.equal(h264CaptureWidth('sharp', 2556, 3420), 2560);
  assert.equal(h264CaptureWidth('ultra', 2556, 3420), 2560);
  assert.equal(h264CaptureWidth('sharp', 2556, 1920), 1920);
});

test('smooth is half the phone, for slow links', () => {
  assert.equal(h264CaptureWidth('smooth', 2556, 3420), 1278);
});

test('never asks past a known source width, and stays even', () => {
  assert.equal(h264CaptureWidth('balanced', 2556, 1440), 1440);
  assert.equal(h264CaptureWidth('balanced', 2555, 0), 2556);
  assert.equal(h264CaptureWidth('balanced', 2556, 1441) % 2, 0);
});

test('an unknown phone size falls back to the JPEG preset width', () => {
  assert.equal(h264CaptureWidth('balanced', 0, 3420), 1024);
  assert.equal(h264CaptureWidth('sharp', Number.NaN, 0), 1600);
});

// ---- wire parsing ----------------------------------------------------------

test('parses a move, and a move that carries the cursor image', () => {
  assert.deepEqual(parsePointerMessage('{"type":"pointer","x":0.5,"y":0.25}'), { x: 0.5, y: 0.25, cursor: null });
  const withShape = parsePointerMessage(JSON.stringify({ type: 'pointer', x: 0.1, y: 0.2, cursor: arrow }));
  assert.deepEqual(withShape, { x: 0.1, y: 0.2, cursor: arrow });
});

test('rejects anything that would put a NaN into layout', () => {
  assert.equal(parsePointerMessage('{"type":"pointer","x":"a","y":0}'), null);
  assert.equal(parsePointerMessage('{"type":"frame","x":0,"y":0}'), null);
  assert.equal(parsePointerMessage('not json'), null);
  assert.equal(parsePointerMessage({ type: 'pointer' }), null);
  // A bad cursor image drops the image, never the move.
  assert.deepEqual(
    parsePointerMessage(JSON.stringify({ type: 'pointer', x: 0, y: 0, cursor: { png: 5, w: 28, h: 40, hx: 5, hy: 5 } })),
    { x: 0, y: 0, cursor: null },
  );
});

// ---- placement over the stage ------------------------------------------------

const stage = { w: 400, h: 259 };

test('puts the hotspot on the normalized position at zoom 1', () => {
  const p = placePointer({ x: 0.5, y: 0.5 }, arrow, stage, 1);
  assert.ok(p);
  assert.equal(p.width, arrow.w * POINTER_SCALE);
  assert.equal(p.height, arrow.h * POINTER_SCALE);
  assert.equal(p.left + arrow.hx * POINTER_SCALE, 200);
  assert.equal(p.top + arrow.hy * POINTER_SCALE, 129.5);
});

test('counter-scales by zoom so the pointer stays the same size on glass', () => {
  const p = placePointer({ x: 0.25, y: 0.75 }, arrow, stage, 4);
  assert.ok(p);
  assert.equal(p.width * 4, arrow.w * POINTER_SCALE);
  // The hotspot still lands on the pointed-at pixel in stage coordinates.
  assert.equal(p.left + (arrow.hx * POINTER_SCALE) / 4, 100);
  assert.equal(p.top + (arrow.hy * POINTER_SCALE) / 4, 194.25);
});

test('nothing to draw off this display, before layout, or without an image', () => {
  assert.equal(placePointer({ x: 1.2, y: 0.5 }, arrow, stage, 1), null);
  assert.equal(placePointer({ x: 0.5, y: -0.01 }, arrow, stage, 1), null);
  assert.equal(placePointer({ x: 0.5, y: 0.5 }, arrow, { w: 0, h: 0 }, 1), null);
  assert.equal(placePointer({ x: 0.5, y: 0.5 }, null, stage, 1), null);
});
