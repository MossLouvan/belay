import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachGamepad } from '../renderer/gamepad.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(t, ticketRequest) {
  let now = 0, serial = 0;
  const scheduled = new Map(), requests = [], sockets = [], effects = [], tuning = [];
  const buttons = Array.from({ length: 17 }, () => Object.freeze({ pressed: false, value: 0 }));
  let pads = [{ connected: true, index: 0, id: '054c-0ce6', mapping: 'standard', axes: [0,0,0,0], buttons,
    vibrationActuator: { playEffect: (type, effect) => { effects.push({ type, effect }); return Promise.resolve(); } } }];
  class Element extends EventTarget {
    attrs = { 'aria-pressed': 'false' }; textContent = ''; title = '';
    getAttribute(key) { return this.attrs[key]; }
    setAttribute(key, value) { this.attrs = { ...this.attrs, [key]: value }; }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0; bufferedAmount = 0; sent = [];
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send(frame) { this.sent.push(frame); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    hello() { this.readyState = 1; this.message({ type: 'hello', available: true, backend: 'vigem' }); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  const doc = new EventTarget(), win = new EventTarget(), indicator = new Element(), toggle = new Element();
  doc.hidden = false;
  const install = (key, value) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, key, before); else delete globalThis[key]; });
  };
  const schedule = (kind, callback, delay) => { const id = ++serial; scheduled.set(id, { kind, callback, delay }); return id; };
  install('document', doc); install('window', win); install('navigator', { getGamepads: () => pads });
  install('WebSocket', Socket); install('performance', { now: () => now });
  install('requestAnimationFrame', cb => schedule('raf', cb)); install('cancelAnimationFrame', id => scheduled.delete(id));
  install('setInterval', (cb, ms) => schedule('interval', cb, ms)); install('clearInterval', id => scheduled.delete(id));
  install('setTimeout', (cb, ms) => schedule('timeout', cb, ms)); install('clearTimeout', id => scheduled.delete(id));
  install('fetch', async (url, options) => {
    requests.push({ url, options });
    return ticketRequest ? ticketRequest() : { ok: true, json: async () => ({ ticket: 'single-use' }) };
  });
  const dispose = attachGamepad({ host: 'http://host:8787', token: 'secret', indicator, toggle, onGaming: enabled => tuning.push(enabled) });
  return {
    sockets, requests, effects, indicator, tuning, scheduled, dispose,
    toggle: () => toggle.dispatchEvent(new Event('click')),
    change: patch => { pads = pads.map(p => ({ ...p, ...patch })); },
    unplug: () => { pads = []; },
    hide: hidden => { doc.hidden = hidden; doc.dispatchEvent(new Event('visibilitychange')); },
    tick: time => {
      now = time;
      for (const [id, job] of [...scheduled]) if (job.kind === 'raf' || job.kind === 'interval') {
        if (job.kind === 'raf') scheduled.delete(id);
        job.callback();
      }
    },
  };
}
test('renderer obtains a ticket, waits for hello, sends binary newest state and routes rumble', async t => {
  const h = harness(t);
  try {
    h.tick(0); assert.equal(h.requests.length, 0);
    h.toggle(); await flush();
    assert.equal(h.requests[0].options.headers.authorization, 'Bearer secret');
    assert.equal(new URL(h.sockets[0].url).pathname, '/ws/gamepad');
    assert.equal(new URL(h.sockets[0].url).search, '?ticket=single-use');
    h.tick(4); assert.equal(h.sockets[0].sent.length, 0);
    const ws = h.sockets[0]; ws.hello(); h.tick(8);
    assert.equal(ws.sent[0].byteLength, 17);
    assert.equal(new DataView(ws.sent[0]).getUint32(13, true), 0);
    ws.bufferedAmount = 35; h.change({ axes: [1,0,0,0] }); h.tick(12);
    ws.bufferedAmount = 0; h.change({ axes: [-1,0,0,0] }); h.tick(16);
    assert.equal(new DataView(ws.sent.at(-1)).getInt16(5, true), -32768);
    assert.equal(new DataView(ws.sent.at(-1)).getUint32(13, true), 1);
    ws.message({ type: 'rumble', low: 0.5, high: 1 });
    assert.equal(h.effects.at(-1).effect.strongMagnitude, 0.5);
    assert.match(h.indicator.textContent, /DualSense.*Xbox controller/);
    h.toggle(); assert.deepEqual(h.tuning, [true, false]);
    assert.equal(ws.readyState, 3);
    assert.equal(new DataView(ws.sent.at(-1)).getInt16(5, true), 0);
    assert.equal(h.effects.at(-1).effect.weakMagnitude, 0);
  } finally { h.dispose(); }
});
test('hidden window switches to 4 ms polling, keeps lease alive and unplug releases input', async t => {
  const h = harness(t);
  try {
    h.toggle(); await flush(); const ws = h.sockets[0]; ws.hello(); h.tick(0);
    h.hide(true);
    assert.equal([...h.scheduled.values()].some(job => job.kind === 'raf'), false);
    assert.equal([...h.scheduled.values()].find(job => job.kind === 'interval').delay, 4);
    h.tick(96); const count = ws.sent.length;
    h.tick(101); assert.equal(ws.sent.length, count);
    h.tick(346); assert.equal(ws.sent.length, count + 1);
    h.hide(false); assert.equal([...h.scheduled.values()].some(job => job.kind === 'interval'), false);
    h.unplug(); h.tick(350); assert.equal(ws.readyState, 3);
    assert.match(h.indicator.textContent, /No pad/);
  } finally { h.dispose(); }
});
test('a ticket arriving after Gaming exits cannot attach a stale controller', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = harness(t, () => pending);
  try {
    h.toggle(); h.toggle();
    resolve({ ok: true, json: async () => ({ ticket: 'late' }) }); await flush();
    assert.equal(h.sockets.length, 0);
  } finally { h.dispose(); }
});
