// Touch-mode drags (#136): press, throttled moves, release — and a release on
// cancel. Old hosts get the one atomic /input/drag on release.
//
//   cd app && node --test src/screen/live-drag.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLiveDrag } from './live-drag.ts';

const rig = () => {
  const calls = [];
  let t = 0;
  const timers = [];
  const io = {
    down: async (p) => { calls.push(['down', p.x, p.y]); },
    move: async (p) => { calls.push(['move', p.x, p.y]); },
    up: async (p) => { calls.push(['up', p.x, p.y]); },
    drag: async (a, b) => { calls.push(['drag', a.x, a.y, b.x, b.y]); },
    onError: (m) => calls.push(['error', m]),
  };
  const clock = {
    now: () => t,
    schedule: (fn, ms) => { timers.push({ at: t + ms, fn }); },
  };
  const advance = async (ms) => {
    t += ms;
    for (const tm of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (tm.at <= t) tm.fn(); else timers.push(tm);
    }
    await settle();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { calls, io, clock, advance, settle, drag: createLiveDrag(io, 40, clock) };
};

const P = (x, y) => ({ x, y });

test('live: down at the start, throttled moves, up at the release, in order', async () => {
  const r = rig();
  r.drag.start(P(0.1, 0.1), true);
  r.drag.move(P(0.2, 0.2)); // first move goes at once
  r.drag.move(P(0.3, 0.3)); // inside the throttle: coalesced…
  r.drag.move(P(0.4, 0.4)); // …into the latest point
  await r.advance(40);
  r.drag.end(P(0.5, 0.5));
  await r.settle();
  assert.deepEqual(r.calls, [
    ['down', 0.1, 0.1],
    ['move', 0.2, 0.2],
    ['move', 0.4, 0.4],
    ['up', 0.5, 0.5],
  ]);
});

test('a move still owed at release is dropped, not sent after the up', async () => {
  const r = rig();
  r.drag.start(P(0, 0), true);
  r.drag.move(P(0.2, 0.2));
  r.drag.move(P(0.3, 0.3)); // throttled
  r.drag.end(P(0.6, 0.6));
  await r.advance(100);
  assert.deepEqual(r.calls.at(-1), ['up', 0.6, 0.6]);
  assert.equal(r.calls.filter((c) => c[0] === 'move').length, 1);
});

test('cancel releases at the last point seen', async () => {
  const r = rig();
  r.drag.start(P(0.1, 0.1), true);
  r.drag.move(P(0.3, 0.2));
  r.drag.cancel();
  await r.settle();
  assert.deepEqual(r.calls.at(-1), ['up', 0.3, 0.2]);
  // A second cancel (unmount after terminate) does not release twice.
  r.drag.cancel();
  await r.settle();
  assert.equal(r.calls.filter((c) => c[0] === 'up').length, 1);
});

test('a failed press still sends the release, and reports the error', async () => {
  const r = rig();
  r.io.down = async () => { throw new Error('held by Jack'); };
  r.drag.start(P(0.1, 0.1), true);
  r.drag.end(P(0.2, 0.2));
  await r.settle();
  assert.deepEqual(r.calls, [['error', 'held by Jack'], ['up', 0.2, 0.2]]);
});

test('old host: nothing until release, then one atomic drag', async () => {
  const r = rig();
  r.drag.start(P(0.1, 0.1), false);
  r.drag.move(P(0.3, 0.3));
  await r.advance(100);
  assert.deepEqual(r.calls, []);
  r.drag.end(P(0.5, 0.5));
  await r.settle();
  assert.deepEqual(r.calls, [['drag', 0.1, 0.1, 0.5, 0.5]]);
  r.drag.cancel(); // nothing held, nothing to release
  await r.settle();
  assert.equal(r.calls.length, 1);
});
