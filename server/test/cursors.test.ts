// Tests for the virtual-cursor registry: colour assignment that is stable per
// device and never collides, coordinate hygiene, the sticky surface, and the
// idle rules that decide who is still on the wire.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURSOR_IDLE_MS, clampUnit, createCursorRegistry, hslToHex, hueDistance,
  hueOfHex, isBrandHue, pickColor, pickHue, publicIdOf,
} from '../src/cursors.js';

// ---- ids -------------------------------------------------------------------

test('publicIdOf is stable, short, and not the token', () => {
  const token = 'a'.repeat(64);
  const id = publicIdOf(token);
  assert.equal(id, publicIdOf(token));
  assert.equal(id.length, 10);
  assert.ok(!token.includes(id), 'id must not be a slice of the token');
  assert.notEqual(id, publicIdOf('b'.repeat(64)));
});

// ---- colour ----------------------------------------------------------------

test('hslToHex round-trips through hueOfHex', () => {
  for (const hue of [0, 47, 120, 200, 275, 359]) {
    const hex = hslToHex(hue, 0.72, 0.76);
    assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.ok(hueDistance(hueOfHex(hex), hue) < 1, `${hue} -> ${hex} -> ${hueOfHex(hex)}`);
  }
});

test('hslToHex at the chosen lightness is genuinely light', () => {
  // Every channel well above mid-grey: the point of "light colour" is that it
  // reads as a highlight over arbitrary desktop content.
  for (const hue of [0, 90, 180, 270]) {
    const hex = hslToHex(hue, 0.72, 0.76);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(r! + g! + b! > 3 * 140, `${hex} is too dark`);
  }
});

test('hueDistance wraps around the circle', () => {
  assert.equal(hueDistance(10, 350), 20);
  assert.equal(hueDistance(350, 10), 20);
  assert.equal(hueDistance(0, 180), 180);
});

test('the brand orange band is reserved', () => {
  assert.ok(isBrandHue(18), 'Belay accent orange');
  assert.ok(!isBrandHue(200));
  const { hue } = pickColor('any-seed', []);
  assert.ok(!isBrandHue(hue));
});

test('pickHue is stable for a seed and avoids hues already taken', () => {
  const a = pickHue('device-a', []);
  assert.equal(a, pickHue('device-a', []), 'same seed, same hue');

  const b = pickHue('device-b', [a]);
  assert.ok(hueDistance(a, b) >= 26, `${a} and ${b} are too close`);
});

test('a room of ten keeps every pair of cursors distinguishable', () => {
  const taken: number[] = [];
  for (let i = 0; i < 10; i += 1) taken.push(pickHue(`device-${i}`, taken));
  for (let i = 0; i < taken.length; i += 1) {
    for (let j = i + 1; j < taken.length; j += 1) {
      assert.ok(hueDistance(taken[i]!, taken[j]!) >= 26,
        `cursor ${i} and ${j} collide at ${taken[i]} / ${taken[j]}`);
    }
  }
});

test('pickHue terminates instead of hanging when the circle is full', () => {
  // Every hue taken: no candidate can clear the gap. It must still return.
  const taken = Array.from({ length: 360 }, (_, i) => i);
  const hue = pickHue('crowded', taken);
  assert.ok(Number.isFinite(hue) && hue >= 0 && hue < 360);
});

// ---- coordinates -----------------------------------------------------------

test('clampUnit pins into 0..1 and rejects the non-finite', () => {
  assert.equal(clampUnit(0.5), 0.5);
  assert.equal(clampUnit(-3), 0);
  assert.equal(clampUnit(9), 1);
  assert.equal(clampUnit(Number.NaN), null);
  assert.equal(clampUnit(Number.POSITIVE_INFINITY), null);
  assert.equal(clampUnit('0.5'), null);
  assert.equal(clampUnit(undefined), null);
});

// ---- registry --------------------------------------------------------------

test('a device keeps its colour across a rejoin', () => {
  const reg = createCursorRegistry();
  const first = reg.join('tok-a', 'Moss');
  reg.leave('tok-a');
  const second = reg.join('tok-a', 'Moss');
  assert.equal(second.color, first.color, 'a flaky network must not re-colour you');
});

test('two devices in a room get different colours', () => {
  const reg = createCursorRegistry();
  const a = reg.join('tok-a', 'Moss');
  const b = reg.join('tok-b', 'Jack');
  assert.notEqual(a.color, b.color);
  assert.ok(hueDistance(hueOfHex(a.color), hueOfHex(b.color)) >= 26);
});

test('a joined device is invisible until it actually points', () => {
  const reg = createCursorRegistry();
  reg.join('tok-a', 'Moss');
  assert.equal(reg.rows().length, 0, 'no cursor parked at the origin');
  reg.move('tok-a', 0.4, 0.6);
  assert.equal(reg.rows().length, 1);
});

test('move clamps, and refuses coordinates it cannot use', () => {
  const reg = createCursorRegistry();
  reg.join('tok-a', 'Moss');
  assert.equal(reg.move('tok-a', 2, -1), true);
  assert.deepEqual([reg.rows()[0]!.x, reg.rows()[0]!.y], [1, 0]);
  assert.equal(reg.move('tok-a', Number.NaN, 0.5), false);
  assert.equal(reg.move('unknown-token', 0.5, 0.5), false);
});

test('the surface is sticky, and screen and window are exclusive', () => {
  const reg = createCursorRegistry();
  reg.join('tok-a', 'Moss');
  reg.move('tok-a', 0.1, 0.1, { screen: 1 });
  assert.equal(reg.rows()[0]!.screen, 1);

  reg.move('tok-a', 0.2, 0.2);                       // no surface: keep it
  assert.equal(reg.rows()[0]!.screen, 1);

  reg.move('tok-a', 0.3, 0.3, { window: 'w42' });    // switch surfaces
  assert.equal(reg.rows()[0]!.window, 'w42');
  assert.equal(reg.rows()[0]!.screen, undefined,
    'a cursor cannot be on a monitor and in a window at once');
});

test('a cursor that stops moving falls off the wire', () => {
  const reg = createCursorRegistry();
  const t0 = 1_000_000;
  reg.join('tok-a', 'Moss', t0);
  reg.move('tok-a', 0.5, 0.5, undefined, t0);
  assert.equal(reg.rows(t0 + CURSOR_IDLE_MS - 1).length, 1);
  assert.equal(reg.rows(t0 + CURSOR_IDLE_MS + 1).length, 0);
});

test('leave removes a cursor at once', () => {
  const reg = createCursorRegistry();
  reg.join('tok-a', 'Moss');
  reg.move('tok-a', 0.5, 0.5);
  reg.leave('tok-a');
  assert.equal(reg.rows().length, 0);
  assert.equal(reg.size(), 0);
});

test('rows can exclude the caller and come back in a stable order', () => {
  const reg = createCursorRegistry();
  for (const t of ['tok-a', 'tok-b', 'tok-c']) {
    reg.join(t, t);
    reg.move(t, 0.5, 0.5);
  }
  assert.equal(reg.rows(Date.now(), 'tok-b').length, 2);
  const ids = reg.rows().map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort(), 'order must be stable for the wire diff');
});

test('acting marks exactly the floor holder', () => {
  let acting: string | null = null;
  const reg = createCursorRegistry({ actingId: () => acting });
  const a = reg.join('tok-a', 'Moss');
  reg.join('tok-b', 'Jack');
  reg.move('tok-a', 0.5, 0.5);
  reg.move('tok-b', 0.5, 0.5);

  assert.deepEqual(reg.rows().map((r) => r.acting), [false, false]);
  acting = a.id;
  const rows = reg.rows();
  assert.equal(rows.filter((r) => r.acting).length, 1);
  assert.equal(rows.find((r) => r.acting)!.id, a.id);
});

test('a row never carries the bearer token', () => {
  const reg = createCursorRegistry();
  const token = 'secret-token-value';
  reg.join(token, 'Moss');
  reg.move(token, 0.5, 0.5);
  assert.ok(!JSON.stringify(reg.rows()).includes(token));
});
