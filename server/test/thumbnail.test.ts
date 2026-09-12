// Tests for GET /screen/thumbnail — the one still-frame surface.
//
// A real express app on an ephemeral port with the real route registered; the
// capture, the clock and the "is capture even possible" probe are injected, so
// every branch that only happens on a broken or unpermitted host (helper down,
// permission denied, a frame over the byte ceiling) is reachable here without
// a Mac, a display or a screen-recording grant. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  RequestBudget,
  THUMB,
  ThumbnailSource,
  jpegBytes,
  registerThumbnailRoutes,
} from '../src/thumbnail.js';
import type { ThumbFrame } from '../src/thumbnail.js';

const TOKEN = 'phone-token';
const OTHER_TOKEN = 'other-phone-token';

/** A frame of `bytes` plausible JPEG bytes, base64 encoded the way capture does. */
function frame(bytes: number, width = THUMB.width): ThumbFrame {
  const data = Buffer.alloc(bytes, 0x41).toString('base64');
  return { data, w: width, h: Math.round(width * 0.625), sw: 2560, sh: 1600, bytes };
}

interface Harness {
  readonly url: string;
  /** [width, quality] of every capture the route actually asked for. */
  readonly captures: Array<readonly [number, number]>;
  readonly close: () => Promise<void>;
  ready: boolean;
  clock: number;
  next: (width: number, quality: number) => Promise<ThumbFrame>;
}

async function harness(over: { ready?: boolean } = {}): Promise<Harness> {
  const app = express();
  app.use(express.json());
  const state = {
    ready: over.ready ?? true,
    clock: 1_000_000,
    captures: [] as Array<readonly [number, number]>,
    next: async (width: number) => frame(4096, width),
  };
  const auth: express.RequestHandler = (req, res, next) => {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token === TOKEN || token === OTHER_TOKEN) {
      (req as express.Request & { device?: { token: string } }).device = { token };
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
  registerThumbnailRoutes(app, auth, {
    capture: (width, quality) => {
      state.captures.push([width, quality]);
      return state.next(width, quality);
    },
    ready: () => state.ready,
    now: () => state.clock,
  });
  const server: Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    captures: state.captures,
    get ready() { return state.ready; }, set ready(v) { state.ready = v; },
    get clock() { return state.clock; }, set clock(v) { state.clock = v; },
    get next() { return state.next; }, set next(v) { state.next = v; },
    close: () => new Promise((r) => { server.close(() => r()); }),
  };
}

const get = (url: string, token: string | null = TOKEN) =>
  fetch(`${url}/screen/thumbnail`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

// ---- auth ----------------------------------------------------------------

test('thumbnail: an unauthenticated request never reaches capture', async () => {
  const h = await harness();
  try {
    const res = await get(h.url, null);
    assert.equal(res.status, 401);
    // The point of the assertion: refusing AFTER capturing would still have
    // photographed the desktop for a stranger.
    assert.equal(h.captures.length, 0);
  } finally { await h.close(); }
});

test('thumbnail: a wrong bearer token is refused', async () => {
  const h = await harness();
  try {
    assert.equal((await get(h.url, 'not-a-real-token')).status, 401);
    assert.equal(h.captures.length, 0);
  } finally { await h.close(); }
});

// ---- the happy path ------------------------------------------------------

test('thumbnail: an authorised request returns one small JPEG and its size', async () => {
  const h = await harness();
  try {
    const res = await get(h.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(typeof body.data, 'string');
    assert.equal(body.w, THUMB.width);
    assert.equal(body.sw, 2560);
    assert.equal(body.cached, false);
    assert.equal(body.capturedAt, h.clock);
    assert.deepEqual(h.captures, [[THUMB.width, THUMB.quality]]);
  } finally { await h.close(); }
});

test('thumbnail: the helper\'s protocol noise never reaches the wire', async () => {
  const h = await harness();
  try {
    // The real native helper answers with a request id and an `ok` flag beside
    // the frame. Spreading its reply would publish those as part of a
    // documented route's shape.
    h.next = async (width: number) => ({ ...frame(2048, width), ok: true, id: 7, ageMs: 12 } as ThumbFrame);
    const body = await (await get(h.url)).json();
    assert.deepEqual(
      Object.keys(body).sort(),
      ['bytes', 'cached', 'capturedAt', 'data', 'h', 'sh', 'sw', 'w'],
    );
  } finally { await h.close(); }
});

// ---- coalescing: this is what protects a live stream ----------------------

test('thumbnail: a second request inside the freshness window costs no capture', async () => {
  const h = await harness();
  try {
    await get(h.url);
    h.clock += THUMB.freshMs - 1;
    const again = await (await get(h.url)).json();
    assert.equal(h.captures.length, 1, 'the held picture should have been reused');
    assert.equal(again.cached, true);
  } finally { await h.close(); }
});

test('thumbnail: the picture is re-taken once it goes stale', async () => {
  const h = await harness();
  try {
    await get(h.url);
    h.clock += THUMB.freshMs;
    const fresh = await (await get(h.url)).json();
    assert.equal(h.captures.length, 2);
    assert.equal(fresh.cached, false);
  } finally { await h.close(); }
});

test('thumbnail: two devices asking at once share one capture', async () => {
  const h = await harness();
  try {
    let release: (f: ThumbFrame) => void = () => {};
    h.next = () => new Promise<ThumbFrame>((r) => { release = r; });
    const both = Promise.all([get(h.url, TOKEN), get(h.url, OTHER_TOKEN)]);
    // Both requests are now parked on the same in-flight capture.
    await new Promise((r) => setTimeout(r, 20));
    release(frame(2048));
    const [a, b] = await both;
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(h.captures.length, 1, 'concurrent askers must not each capture');
  } finally { await h.close(); }
});

// ---- the request budget --------------------------------------------------

test('thumbnail: a client past its budget gets 429 and a Retry-After', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < THUMB.burst; i += 1) {
      assert.equal((await get(h.url)).status, 200);
    }
    const refused = await get(h.url);
    assert.equal(refused.status, 429);
    const after = Number(refused.headers.get('retry-after'));
    assert.ok(after >= 1 && after <= Math.ceil(THUMB.windowMs / 1000), `odd Retry-After: ${after}`);
    assert.equal((await refused.json()).retryAfterSec, after);
  } finally { await h.close(); }
});

test('thumbnail: one greedy device does not spend another device\'s budget', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < THUMB.burst; i += 1) await get(h.url, TOKEN);
    assert.equal((await get(h.url, TOKEN)).status, 429);
    assert.equal((await get(h.url, OTHER_TOKEN)).status, 200);
  } finally { await h.close(); }
});

test('thumbnail: the budget refills after its window', async () => {
  const h = await harness();
  try {
    for (let i = 0; i < THUMB.burst; i += 1) await get(h.url, TOKEN);
    assert.equal((await get(h.url, TOKEN)).status, 429);
    h.clock += THUMB.windowMs;
    assert.equal((await get(h.url, TOKEN)).status, 200);
  } finally { await h.close(); }
});

// ---- capture unavailable -------------------------------------------------

test('thumbnail: a host with no working capture answers 503, not 500', async () => {
  const h = await harness({ ready: false });
  try {
    const res = await get(h.url);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not available/);
    assert.equal(h.captures.length, 0);
  } finally { await h.close(); }
});

test('thumbnail: a capture that throws (no permission) degrades to 503', async () => {
  const h = await harness();
  try {
    h.next = async () => { throw new Error('screen recording permission is not granted'); };
    const res = await get(h.url);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /permission/);
  } finally { await h.close(); }
});

test('thumbnail: a failed capture is not remembered as the held picture', async () => {
  const h = await harness();
  try {
    h.next = async () => { throw new Error('helper is down'); };
    assert.equal((await get(h.url)).status, 503);
    h.next = async (width: number) => frame(1024, width);
    // No freshness window to wait out: the failure left nothing behind.
    assert.equal((await get(h.url)).status, 200);
  } finally { await h.close(); }
});

// ---- the size bound ------------------------------------------------------

test('thumbnail: an oversized frame is retried once at a smaller size', async () => {
  const h = await harness();
  try {
    h.next = async (width: number) =>
      width === THUMB.width ? frame(THUMB.maxBytes + 1, width) : frame(8192, width);
    const body = await (await get(h.url)).json();
    assert.equal(body.w, THUMB.retryWidth);
    assert.deepEqual(h.captures, [
      [THUMB.width, THUMB.quality],
      [THUMB.retryWidth, THUMB.retryQuality],
    ]);
  } finally { await h.close(); }
});

test('thumbnail: a frame still over the ceiling after the retry is refused', async () => {
  const h = await harness();
  try {
    h.next = async (width: number) => frame(THUMB.maxBytes * 2, width);
    const res = await get(h.url);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /larger than/);
    assert.equal(h.captures.length, 2, 'exactly one retry, never a third guess');
  } finally { await h.close(); }
});

test('thumbnail: the ceiling is measured from the payload, not the helper\'s claim', async () => {
  const h = await harness();
  try {
    // A helper that under-reports its own size must not talk its way past the
    // bound — the base64 is what actually crosses the link.
    h.next = async (width: number) => ({ ...frame(THUMB.maxBytes + 1024, width), bytes: 10 });
    const res = await get(h.url);
    assert.equal(res.status, 503);
    assert.equal(h.captures.length, 2);
  } finally { await h.close(); }
});

// ---- units ---------------------------------------------------------------

test('jpegBytes: decodes the true length from base64, padding included', () => {
  for (const n of [1, 2, 3, 100, 4095, 4096]) {
    assert.equal(jpegBytes({ data: Buffer.alloc(n, 7).toString('base64'), bytes: 0 }), n);
  }
});

test('jpegBytes: an empty payload falls back to the reported count', () => {
  assert.equal(jpegBytes({ data: '', bytes: 42 }), 42);
});

test('RequestBudget: keys are independent and windows are fixed', () => {
  let clock = 0;
  const budget = new RequestBudget({ limit: 2, windowMs: 100, now: () => clock });
  assert.equal(budget.check('a').allowed, true);
  assert.equal(budget.check('a').allowed, true);
  assert.equal(budget.check('a').allowed, false);
  assert.equal(budget.check('b').allowed, true);
  clock = 99;
  assert.equal(budget.check('a').allowed, false);
  clock = 100;
  assert.equal(budget.check('a').allowed, true);
});

test('RequestBudget: a refusal says how long to wait, rounded up and never zero', () => {
  let clock = 0;
  const budget = new RequestBudget({ limit: 1, windowMs: 5000, now: () => clock });
  budget.check('a');
  clock = 4999;
  const decision = budget.check('a');
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.retryAfterSec, 1);
});

test('ThumbnailSource: forget() drops the held picture so the next ask re-captures', async () => {
  let clock = 0;
  let taken = 0;
  const source = new ThumbnailSource({
    capture: async () => { taken += 1; return frame(512); },
    ready: () => true,
    now: () => clock,
  });
  await source.get();
  await source.get();
  assert.equal(taken, 1);
  source.forget();
  await source.get();
  assert.equal(taken, 2);
});
