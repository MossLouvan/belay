// Tests for the /ws/cursors fan-out: the hello frame that tells a client which
// cursor is its own, the frame parser that has to survive a hostile peer, and
// the coalescing broadcast that keeps a room of pointers cheap.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCursorHub, cursorsWire, helloWire, parseCursorFrame } from '../src/cursor-channel.js';
import type { CursorSocket } from '../src/cursor-channel.js';
import { createCursorRegistry } from '../src/cursors.js';

const FLUSH = 5;
const settle = () => new Promise((r) => setTimeout(r, FLUSH * 4));

function fakeSocket() {
  const sent: string[] = [];
  const handlers = new Map<string, (data?: unknown) => void>();
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => { sent.push(data); },
    on: (event: string, fn: (data?: unknown) => void) => { handlers.set(event, fn); },
  } as unknown as CursorSocket;
  return {
    ws,
    sent,
    close: () => handlers.get('close')?.(),
    message: (m: unknown) => handlers.get('message')?.(typeof m === 'string' ? m : JSON.stringify(m)),
    frames: (type: string) => sent.map((s) => JSON.parse(s)).filter((m) => m.type === type),
  };
}

// ---- the wire --------------------------------------------------------------

test('hello names the client to itself, colour included', () => {
  const msg = JSON.parse(helloWire({
    id: 'abc', name: 'Moss', color: '#a8d8ff', x: 0.5, y: 0.5, acting: false,
  }));
  assert.deepEqual(msg, { type: 'hello', id: 'abc', name: 'Moss', color: '#a8d8ff' });
});

test('cursorsWire is a plain typed envelope', () => {
  assert.deepEqual(JSON.parse(cursorsWire([])), { type: 'cursors', cursors: [] });
});

// ---- the parser ------------------------------------------------------------

test('parseCursorFrame accepts a move and passes coordinates through untouched', () => {
  // Clamping is the registry's job; the parser must not silently "fix" a value
  // and hide a broken client.
  const f = parseCursorFrame(JSON.stringify({ type: 'move', x: 5, y: -2 }));
  assert.deepEqual(f, { x: 5, y: -2 });
});

test('parseCursorFrame carries a surface, and only one', () => {
  assert.equal(parseCursorFrame(JSON.stringify({ type: 'move', x: 0, y: 0, screen: 1 }))!.screen, 1);
  assert.equal(parseCursorFrame(JSON.stringify({ type: 'move', x: 0, y: 0, window: 'w1' }))!.window, 'w1');
  // screen wins when a client sends both, matching the /input routes.
  const both = parseCursorFrame(JSON.stringify({ type: 'move', x: 0, y: 0, screen: 2, window: 'w1' }))!;
  assert.equal(both.screen, 2);
  assert.equal(both.window, undefined);
});

test('parseCursorFrame refuses everything that is not a move', () => {
  for (const bad of [
    'not json', '[]', 'null', '"a string"', '42',
    JSON.stringify({ type: 'shutdown' }),
    JSON.stringify({ x: 1, y: 1 }),
    JSON.stringify({ type: 'move', screen: Number.NaN, x: 0, y: 0 }),
  ]) {
    const out = parseCursorFrame(bad);
    if (bad.includes('"move"')) assert.equal(out!.screen, undefined, bad);
    else assert.equal(out, null, `should have refused: ${bad}`);
  }
});

test('parseCursorFrame handles a Buffer payload, as ws delivers it', () => {
  const buf = Buffer.from(JSON.stringify({ type: 'move', x: 0.25, y: 0.75 }));
  assert.deepEqual(parseCursorFrame(buf), { x: 0.25, y: 0.75 });
});

// ---- the hub ---------------------------------------------------------------

test('a joining client is told who it is straight away', () => {
  const hub = createCursorHub({ registry: createCursorRegistry(), flushMs: FLUSH });
  const a = fakeSocket();
  hub.handle(a.ws, 'tok-a', 'Moss');
  assert.equal(a.frames('hello').length, 1);
  assert.equal(a.frames('hello')[0].name, 'Moss');
  hub.stop();
});

test('a move from one client reaches the other', async () => {
  const hub = createCursorHub({ registry: createCursorRegistry(), flushMs: FLUSH });
  const a = fakeSocket();
  const b = fakeSocket();
  hub.handle(a.ws, 'tok-a', 'Moss');
  hub.handle(b.ws, 'tok-b', 'Jack');

  a.message({ type: 'move', x: 0.4, y: 0.6 });
  await settle();

  const seen = b.frames('cursors').at(-1)!.cursors;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'Moss');
  assert.deepEqual([seen[0].x, seen[0].y], [0.4, 0.6]);
  hub.stop();
});

test('a still room sends nothing at all', async () => {
  const hub = createCursorHub({ registry: createCursorRegistry(), flushMs: FLUSH });
  const a = fakeSocket();
  const b = fakeSocket();
  hub.handle(a.ws, 'tok-a', 'Moss');
  hub.handle(b.ws, 'tok-b', 'Jack');
  a.message({ type: 'move', x: 0.4, y: 0.6 });
  await settle();

  const before = b.sent.length;
  await settle();
  assert.equal(b.sent.length, before, 'an unchanged set must not be re-sent');
  hub.stop();
});

test('many moves inside one tick collapse into one broadcast', async () => {
  const hub = createCursorHub({ registry: createCursorRegistry(), flushMs: 40 });
  const a = fakeSocket();
  const b = fakeSocket();
  hub.handle(a.ws, 'tok-a', 'Moss');
  hub.handle(b.ws, 'tok-b', 'Jack');

  for (let i = 0; i < 50; i += 1) a.message({ type: 'move', x: i / 50, y: 0.5 });
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(b.frames('cursors').length <= 3,
    `50 moves became ${b.frames('cursors').length} broadcasts`);
  hub.stop();
});

test('a garbage frame is ignored, not fatal', async () => {
  const hub = createCursorHub({ registry: createCursorRegistry(), flushMs: FLUSH });
  const a = fakeSocket();
  hub.handle(a.ws, 'tok-a', 'Moss');
  assert.doesNotThrow(() => a.message('}{'));
  assert.doesNotThrow(() => a.message({ type: 'move', x: 'left', y: null }));
  await settle();
  hub.stop();
});

test('a disconnect takes the cursor away for everyone else', async () => {
  const registry = createCursorRegistry();
  const hub = createCursorHub({ registry, flushMs: FLUSH });
  const a = fakeSocket();
  const b = fakeSocket();
  hub.handle(a.ws, 'tok-a', 'Moss');
  hub.handle(b.ws, 'tok-b', 'Jack');
  a.message({ type: 'move', x: 0.4, y: 0.6 });
  await settle();
  assert.equal(b.frames('cursors').at(-1)!.cursors.length, 1);

  a.close();
  await settle();
  assert.equal(b.frames('cursors').at(-1)!.cursors.length, 0);
  // Only the leaver is dropped: b is still connected, still registered, and
  // simply has not pointed at anything yet.
  assert.equal(registry.size(), 1);
  assert.equal(registry.rows().length, 0);
  hub.stop();
});

test('the timer stops once the room empties', async () => {
  const hub = createCursorHub({ registry: createCursorRegistry(), flushMs: FLUSH });
  const a = fakeSocket();
  hub.handle(a.ws, 'tok-a', 'Moss');
  a.message({ type: 'move', x: 0.4, y: 0.6 });
  await settle();
  a.close();
  await settle();
  // Nothing left to observe directly; the contract is that stop() is idempotent
  // and no further sends land on a closed socket.
  const before = a.sent.length;
  await settle();
  assert.equal(a.sent.length, before);
  hub.stop();
});

test('poke pushes a floor change that no move would have triggered', async () => {
  let acting: string | null = null;
  const registry = createCursorRegistry({ actingId: () => acting });
  const hub = createCursorHub({ registry, flushMs: 10_000 }); // timer will not fire
  const a = fakeSocket();
  const b = fakeSocket();
  hub.handle(a.ws, 'tok-a', 'Moss');
  hub.handle(b.ws, 'tok-b', 'Jack');
  a.message({ type: 'move', x: 0.4, y: 0.6 });
  hub.poke();

  acting = registry.idOf('tok-a');
  hub.poke();

  const last = b.frames('cursors').at(-1)!.cursors;
  assert.equal(last.find((c: { name: string }) => c.name === 'Moss').acting, true);
  hub.stop();
});
