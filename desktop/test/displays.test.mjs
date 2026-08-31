// Unit tests for display selection in the desktop client.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { displaysOf, preferredDisplay, fitWindow } from '../src/displays.js';

test('displaysOf keeps the host verdict and drops unusable entries', () => {
  const displays = displaysOf({
    screens: [
      { index: 0, W: 1920, H: 1080, primary: true, label: 'DELL U2720Q' },
      { index: 1, W: 2560, H: 1440, primary: false, virtualDisplay: true, label: 'Virtual Display' },
      { index: -1, W: 800, H: 600 },
      { W: 800, H: 600 },
      null,
    ],
  });
  assert.deepEqual(displays.map((d) => [d.index, d.virtual, d.name]), [
    [0, false, 'DELL U2720Q'],
    [1, true, 'Virtual Display'],
  ]);
});

test('displaysOf names an unlabelled display by its number', () => {
  assert.equal(displaysOf({ screens: [{ index: 2, W: 1, H: 1 }] })[0].name, 'Display 3');
});

test('a host that enumerates nothing yields no displays', () => {
  assert.deepEqual(displaysOf(null), []);
  assert.deepEqual(displaysOf({ screens: 'lots' }), []);
});

test('a virtual display outranks the primary', () => {
  const displays = displaysOf({
    screens: [
      { index: 0, W: 1920, H: 1080, primary: true },
      { index: 1, W: 2560, H: 1440, virtualDisplay: true },
    ],
  });
  assert.equal(preferredDisplay(displays).index, 1);
});

test('without a virtual display the primary wins, then the first listed', () => {
  const withPrimary = displaysOf({ screens: [{ index: 0, W: 1, H: 1 }, { index: 1, W: 1, H: 1, primary: true }] });
  assert.equal(preferredDisplay(withPrimary).index, 1);
  const noPrimary = displaysOf({ screens: [{ index: 3, W: 1, H: 1 }, { index: 4, W: 1, H: 1 }] });
  assert.equal(preferredDisplay(noPrimary).index, 3);
  assert.equal(preferredDisplay([]), undefined);
});

test('fitWindow preserves the remote aspect ratio', () => {
  const { width, height } = fitWindow({ w: 3840, h: 2160 }, { width: 1920, height: 1080 }, 80);
  assert.equal(Math.round((width / height) * 100), Math.round((3840 / 2160) * 100));
  assert.ok(width <= 1920 - 80 && height <= 1080 - 80, 'fits inside the work area');
});

test('fitWindow never upscales a small remote display', () => {
  const { width, height } = fitWindow({ w: 1280, h: 720 }, { width: 3840, height: 2160 });
  assert.deepEqual({ width, height }, { width: 1280, height: 720 });
});

test('fitWindow copes with a host that reported no geometry', () => {
  const { width, height } = fitWindow({ w: 0, h: 0 }, undefined);
  assert.ok(width > 0 && height > 0);
});
