// Unit tests for seamless-window behaviour.
//
// The interesting cases are the ones that make a window misbehave on screen:
// resizing on every frame because of a one-pixel rounding difference, jumping
// to the host's coordinates when the user moved it locally, and a batch of
// windows opening on top of each other.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  windowsOf, windowLabel, shouldResize, aspectFit, scaleOf, initialSize, cascadeOffset,
} from '../src/windows.js';

test('windowsOf keeps valid rows and orders them front to back', () => {
  const windows = windowsOf({
    windows: [
      { id: '67084', title: 'Discord', app: 'Discord', W: 1920, H: 1032, minimized: false, z: 2 },
      { id: '264330', title: 'Monkeytype', app: 'chrome', W: 1920, H: 1032, minimized: false, z: 0 },
      { id: 'nope', title: 'bad handle' },
      { title: 'no handle' },
      null,
    ],
  });
  assert.deepEqual(windows.map((w) => w.id), ['264330', '67084']);
});

test('windowsOf drops duplicates and copes with nothing at all', () => {
  assert.equal(windowsOf({ windows: [{ id: '7', W: 1, H: 1 }, { id: '7', W: 2, H: 2 }] }).length, 1);
  assert.deepEqual(windowsOf(null), []);
  assert.deepEqual(windowsOf({ windows: 'some' }), []);
});

test('a window label leads with the app and falls back sensibly', () => {
  assert.equal(windowLabel({ app: 'chrome', title: 'Monkeytype' }), 'chrome — Monkeytype');
  assert.equal(windowLabel({ app: '', title: 'Just a title' }), 'Just a title');
  assert.equal(windowLabel({ app: 'Discord', title: '' }), 'Discord');
  assert.equal(windowLabel({}), 'Untitled window');
});

test('a one-pixel difference does not trigger a resize', () => {
  // Without the tolerance the window shivers: the host reports integer pixels
  // and the local window has its own DPI scaling, so they rarely agree exactly.
  const current = { width: 800, height: 430 };
  assert.equal(shouldResize(current, { W: 800, H: 430 }), false);
  assert.equal(shouldResize(current, { W: 801, H: 430 }), false);
});

test('a real remote resize does trigger one', () => {
  assert.equal(shouldResize({ width: 800, height: 430 }, { W: 1200, H: 645 }, 1), true);
});

test('scaleOf reads the zoom the user is currently viewing at', () => {
  assert.equal(scaleOf({ width: 960, height: 480 }, { W: 1920, H: 960 }), 0.5);
  assert.equal(scaleOf(null, { W: 1920, H: 960 }), 1);
  assert.equal(scaleOf({ width: 960 }, { W: 0 }), 1);
});

test('a window with no size yet is always resized, and rubbish never is', () => {
  assert.equal(shouldResize(null, { W: 800, H: 600 }), true);
  assert.equal(shouldResize({ width: 800, height: 600 }, { W: 0, H: 0 }), false);
  assert.equal(shouldResize({ width: 800, height: 600 }, null), false);
});

test('a remote resize keeps the scale the user chose', () => {
  // The user shrank a 1920-wide window to 960 locally, so the scale is 0.5.
  // The remote window grows to 2400 wide; the local one should follow to 1200,
  // not leap to the remote's own 2400.
  const scale = scaleOf({ width: 960, height: 480 }, { W: 1920, H: 960 });
  assert.deepEqual(aspectFit({ W: 2400, H: 1200 }, scale), { width: 1200, height: 600 });
});

test('a window shown at half scale is not resized by its own frames', () => {
  // The regression this guards: deriving the scale from each new frame made
  // every frame look like a resize, so a half-scale window crept back to full.
  const current = { width: 960, height: 480 };
  assert.equal(shouldResize(current, { W: 1920, H: 960 }, 0.5), false);
});

test('initialSize never upscales a small window', () => {
  assert.deepEqual(initialSize({ w: 400, h: 300 }, { width: 3840, height: 2160 }),
                   { width: 400, height: 300 });
});

test('initialSize fits a huge window inside the local screen', () => {
  const { width, height } = initialSize({ w: 3840, h: 2160 }, { width: 1920, height: 1080 }, 120);
  assert.ok(width <= 1800 && height <= 960, `got ${width}x${height}`);
  assert.equal(Math.round((width / height) * 100), Math.round((3840 / 2160) * 100));
});

test('a batch of windows cascades instead of stacking', () => {
  assert.deepEqual(cascadeOffset(0), { x: 0, y: 0 });
  assert.deepEqual(cascadeOffset(3), { x: 96, y: 96 });
  // Wraps rather than marching off the bottom-right of the screen.
  assert.deepEqual(cascadeOffset(8), { x: 0, y: 0 });
});
