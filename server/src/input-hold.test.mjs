// /input/down and /input/up — the live-drag routes (#136).
//
//   cd server && node --test src/input-hold.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHoldGuard, parseHold, registerHoldRoutes } from './input-hold.ts';

const fakeRes = () => {
  const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
  return r;
};

/** A fake express app that records what each route was registered with. */
const fakeApp = () => {
  const routes = {};
  return { routes, post(path, ...handlers) { routes[path] = handlers; } };
};

const deps = (over = {}) => {
  const calls = [];
  const native = {
    down: async (...a) => { calls.push(['down', ...a]); },
    up: async (...a) => { calls.push(['up', ...a]); },
  };
  const auth = () => {};
  // The real withFloor grants or refuses; the fake does whichever the test says.
  const withFloor = async (_req, res, act) => {
    if (over.floor === 'denied') { res.status(409).json({ error: 'held' }); return false; }
    await act();
    return true;
  };
  return { calls, auth, withFloor, native, screenIndexOf: (v) => (typeof v === 'number' ? v : undefined), windowIdOf: () => undefined, guard: createHoldGuard(native, 60_000) };
};

test('parseHold accepts a finite point and a known button, refuses everything else', () => {
  assert.deepEqual(parseHold({ x: 0.5, y: 0.25 }), { ok: true, button: 'left', x: 0.5, y: 0.25 });
  assert.deepEqual(parseHold({ x: 0.5, y: 0.25, button: 'right' }), { ok: true, button: 'right', x: 0.5, y: 0.25 });
  for (const bad of [{}, { x: 'a', y: 1 }, { x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: 1, y: 1, button: 'evil' }, null]) {
    assert.equal(parseHold(bad).ok, false, JSON.stringify(bad));
  }
});

test('both routes sit behind the auth middleware', () => {
  const app = fakeApp();
  const d = deps();
  registerHoldRoutes(app, d);
  assert.equal(app.routes['/input/down'][0], d.auth);
  assert.equal(app.routes['/input/up'][0], d.auth);
});

test('down presses through the floor; up releases', async () => {
  const app = fakeApp();
  const d = deps();
  registerHoldRoutes(app, d);
  const down = app.routes['/input/down'].at(-1);
  const up = app.routes['/input/up'].at(-1);
  let res = fakeRes();
  await down({ body: { x: 0.1, y: 0.2, screen: 1 } }, res);
  assert.deepEqual(res.body, { ok: true });
  res = fakeRes();
  await up({ body: { x: 0.3, y: 0.4, screen: 1 } }, res);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(d.calls, [['down', 'left', 0.1, 0.2, 1, undefined], ['up', 'left', 0.3, 0.4, 1, undefined]]);
});

test('a refused floor presses nothing', async () => {
  const app = fakeApp();
  const d = deps({ floor: 'denied' });
  registerHoldRoutes(app, d);
  const res = fakeRes();
  await app.routes['/input/down'].at(-1)({ body: { x: 0.1, y: 0.2 } }, res);
  assert.equal(res.code, 409);
  assert.deepEqual(d.calls, []);
});

test('a bad body is a 400 before anything is pressed', async () => {
  const app = fakeApp();
  const d = deps();
  registerHoldRoutes(app, d);
  const res = fakeRes();
  await app.routes['/input/down'].at(-1)({ body: { x: 'nope' } }, res);
  assert.equal(res.code, 400);
  assert.deepEqual(d.calls, []);
});

test('a press the phone never releases is released by the guard', async () => {
  const calls = [];
  const native = { up: async (...a) => { calls.push(a); } };
  let fire;
  const timers = { set: (fn) => { fire = fn; return 1; }, clear: () => { fire = undefined; } };
  const guard = createHoldGuard(native, 100, timers);
  guard.held('left', 2);
  guard.touch(); // a move re-arms rather than releasing
  assert.ok(fire);
  await fire();
  assert.deepEqual(calls, [['left', undefined, undefined, 2, undefined]]);
  // An explicit up disarms it: nothing fires later.
  guard.held('left', 2);
  guard.released();
  assert.equal(fire, undefined);
});
