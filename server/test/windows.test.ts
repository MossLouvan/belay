// Unit tests for the per-window remoting validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanTitle, openableWindows, sanitizeWindows, windowIdOf } from '../src/windows.js';

test('a window handle is accepted only as digits', () => {
  assert.equal(windowIdOf('264330'), '264330');
  assert.equal(windowIdOf(264330), '264330');
  assert.equal(windowIdOf('  264330  '), '264330');
});

test('anything that is not a plain handle is refused', () => {
  const bad = ['', '0', '000', '-5', '12.5', '12abc', 'null', null, undefined, {}, [], '1'.repeat(21)];
  for (const value of bad) {
    assert.equal(windowIdOf(value), undefined, `expected undefined for ${JSON.stringify(value)}`);
  }
});

test('titles are stripped of control characters and capped', () => {
  assert.equal(cleanTitle('Notepad\r\n'), 'Notepad');
  assert.equal(cleanTitle('bell\u0007 and escape\u001b[31m'), 'bell  and escape [31m');
  assert.equal(cleanTitle('x'.repeat(300)).length, 120);
  assert.equal(cleanTitle(42), '');
});

test('sanitizeWindows keeps usable rows and drops the rest', () => {
  const windows = sanitizeWindows([
    { id: '264330', title: 'Chrome', app: 'chrome', X: 0, Y: 0, W: 1920, H: 1032, minimized: false, z: 0 },
    { id: '0', title: 'not a window' },
    { title: 'no handle at all' },
    null,
    'nope',
  ]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, '264330');
  assert.equal(windows[0].title, 'Chrome');
});

test('a duplicate handle appears once', () => {
  const windows = sanitizeWindows([
    { id: '7', title: 'first', W: 100, H: 100 },
    { id: '7', title: 'second', W: 100, H: 100 },
  ]);
  assert.deepEqual(windows.map((w) => w.title), ['first']);
});

test('odd geometry is coerced rather than dropping the window', () => {
  const [window] = sanitizeWindows([{ id: '9', title: 'Odd', X: 'left', Y: NaN, W: 800.6, H: 600 }]);
  assert.deepEqual([window.X, window.Y, window.W, window.H], [0, 0, 801, 600]);
});

test('minimized and zero-size windows are listed but not openable', () => {
  const windows = sanitizeWindows([
    { id: '1', title: 'Visible', W: 800, H: 600, minimized: false },
    { id: '2', title: 'Minimized', W: 146, H: 28, minimized: true },
    { id: '3', title: 'Zero', W: 0, H: 0, minimized: false },
  ]);
  assert.equal(windows.length, 3);
  assert.deepEqual(openableWindows(windows).map((w) => w.id), ['1']);
});

test('a helper that reports nothing yields an empty list', () => {
  assert.deepEqual(sanitizeWindows(undefined), []);
  assert.deepEqual(sanitizeWindows({ windows: [] }), []);
});
