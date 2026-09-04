// Unit tests for the collaborator-cursor overlay logic.
//
//   cd app && node --test src/screen/cursors.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules.
//
// Two things are worth being strict about. The parser is fed by a socket and
// its output goes straight into React Native layout, where a NaN offset is a
// crash rather than a cosmetic bug — so every row is validated, not trusted.
// And the tag placement has to keep a name beside its cursor at the edges of
// the picture, which is exactly where naive "cursor + 10px" gets clipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TAG_GAP, TAG_HEIGHT, inkOn, parseCursorMessage, placeTag, tagWidth,
  toPixels, visibleCursors,
} from './cursors.ts';

const row = (over = {}) => ({
  id: 'aaa', name: 'Moss', color: '#a8d8ff', x: 0.5, y: 0.5, acting: false, ...over,
});
const wire = (cursors) => JSON.stringify({ type: 'cursors', cursors });

// ---- parsing ---------------------------------------------------------------

test('hello names this client and its colour', () => {
  const m = parseCursorMessage(JSON.stringify({
    type: 'hello', id: 'abc', name: 'Moss', color: '#a8d8ff',
  }));
  assert.deepEqual(m, { kind: 'hello', id: 'abc', name: 'Moss', color: '#a8d8ff' });
});

test('hello without a usable id is refused', () => {
  assert.equal(parseCursorMessage(JSON.stringify({ type: 'hello', id: '' })), null);
  assert.equal(parseCursorMessage(JSON.stringify({ type: 'hello', id: 42 })), null);
});

test('hello falls back to a neutral colour rather than dropping the frame', () => {
  const m = parseCursorMessage(JSON.stringify({ type: 'hello', id: 'abc', color: 'red' }));
  assert.equal(m.color, '#cccccc');
});

test('a cursor list round-trips', () => {
  const m = parseCursorMessage(wire([row()]));
  assert.equal(m.kind, 'cursors');
  assert.equal(m.cursors.length, 1);
  assert.equal(m.cursors[0].name, 'Moss');
});

test('rows with unusable coordinates are dropped, not rendered as NaN', () => {
  // A NaN offset reaching React Native layout is a hard crash, so this is the
  // one place the parser must be pedantic.
  const m = parseCursorMessage(JSON.stringify({
    type: 'cursors',
    cursors: [
      row({ id: 'ok' }),
      row({ id: 'nan-x', x: Number.NaN }),
      row({ id: 'string-y', y: '0.5' }),
      row({ id: 'missing-colour', color: undefined }),
      row({ id: 'bad-colour', color: 'chartreuse' }),
      row({ id: '' }),
      null,
      'not an object',
    ],
  }));
  assert.deepEqual(m.cursors.map((c) => c.id), ['ok']);
});

test('coordinates are clamped into the picture', () => {
  const m = parseCursorMessage(wire([row({ x: 4, y: -2 })]));
  assert.deepEqual([m.cursors[0].x, m.cursors[0].y], [1, 0]);
});

test('a nameless cursor still draws', () => {
  const m = parseCursorMessage(wire([row({ name: undefined })]));
  assert.equal(m.cursors[0].name, '');
});

test('acting is true only when the host says so', () => {
  assert.equal(parseCursorMessage(wire([row({ acting: true })])).cursors[0].acting, true);
  assert.equal(parseCursorMessage(wire([row({ acting: 'yes' })])).cursors[0].acting, false);
  assert.equal(parseCursorMessage(wire([row()])).cursors[0].acting, false);
});

test('junk on the socket is ignored', () => {
  for (const bad of ['', '}{', 'null', '[]', '"a string"', '7',
    JSON.stringify({ type: 'cursors' }),
    JSON.stringify({ type: 'cursors', cursors: 'nope' }),
    JSON.stringify({ type: 'something-else' })]) {
    assert.equal(parseCursorMessage(bad), null, `should have refused: ${bad}`);
  }
});

// ---- who gets drawn --------------------------------------------------------

test('our own cursor is never drawn twice', () => {
  const cursors = [row({ id: 'me' }), row({ id: 'them' })];
  assert.deepEqual(visibleCursors(cursors, 'me').map((c) => c.id), ['them']);
});

test('with no identity yet, everyone is drawn', () => {
  const cursors = [row({ id: 'a' }), row({ id: 'b' })];
  assert.equal(visibleCursors(cursors, null).length, 2);
});

test('a cursor on another monitor stays off this one', () => {
  const cursors = [
    row({ id: 'here', screen: 0 }),
    row({ id: 'there', screen: 1 }),
    row({ id: 'unsaid' }),
  ];
  // An unqualified row is treated as the primary, matching the host's rule
  // that "neither screen nor window" means the primary monitor.
  assert.deepEqual(
    visibleCursors(cursors, null, { screen: 0 }).map((c) => c.id),
    ['here', 'unsaid'],
  );
  assert.deepEqual(
    visibleCursors(cursors, null, { screen: 1 }).map((c) => c.id),
    ['there'],
  );
});

test('in a seamless window, only cursors in that window are drawn', () => {
  const cursors = [
    row({ id: 'in', window: 'w1' }),
    row({ id: 'other', window: 'w2' }),
    row({ id: 'on-a-monitor', screen: 0 }),
  ];
  assert.deepEqual(
    visibleCursors(cursors, null, { window: 'w1' }).map((c) => c.id),
    ['in'],
  );
});

// ---- the name tag ----------------------------------------------------------

test('the tag sits to the right of the cursor when there is room', () => {
  const p = placeTag(100, 100, 'Moss', 1000, 800);
  assert.equal(p.side, 'right');
  assert.equal(p.left, 100 + TAG_GAP);
  assert.equal(p.top, 100 + TAG_GAP);
});

test('the tag flips left rather than being clipped at the right edge', () => {
  const p = placeTag(995, 100, 'Moss', 1000, 800);
  assert.equal(p.side, 'left');
  assert.ok(p.left < 995, 'tag must move back into the picture');
  assert.ok(p.left >= 0);
});

test('a flipped tag never runs off the left edge either', () => {
  // Narrow view, long name: neither side fits, and the clamp has to win.
  const p = placeTag(30, 10, 'a-very-long-display-name', 60, 60);
  assert.ok(p.left >= 0, `left was ${p.left}`);
});

test('the tag is clamped so it stays on screen at the bottom', () => {
  const p = placeTag(100, 795, 'Moss', 1000, 800);
  assert.ok(p.top + TAG_HEIGHT <= 800, `tag bottom was ${p.top + TAG_HEIGHT}`);
});

test('a longer name makes a wider tag', () => {
  assert.ok(tagWidth('Jack') < tagWidth('Jack on the studio iPad'));
  assert.ok(tagWidth('') > 0, 'an empty name still has padding');
});

// ---- contrast --------------------------------------------------------------

test('dark ink on the light pastels the host assigns', () => {
  for (const pastel of ['#a8d8ff', '#ffe6a8', '#c9f7c1', '#f5c2e7']) {
    assert.equal(inkOn(pastel), '#101010', pastel);
  }
});

test('light ink if a colour ever comes back dark', () => {
  assert.equal(inkOn('#101822'), '#f6f4f1');
});

test('inkOn survives a colour it cannot parse', () => {
  assert.equal(inkOn('nonsense'), '#101010');
});

// ---- geometry --------------------------------------------------------------

test('normalized coordinates land where the frame shows them', () => {
  assert.deepEqual(toPixels({ x: 0.5, y: 0.25 }, 800, 600), { x: 400, y: 150 });
  assert.deepEqual(toPixels({ x: 0, y: 1 }, 800, 600), { x: 0, y: 600 });
});
