// Tests for asking a computer for a still: what the phone accepts off the
// network, and the fact that every way the host can say no is the same quiet
// "no picture" to the caller. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { MAX_STILL_BASE64, fetchHostStill, parseHostStill } from './preview-fetch.ts';

const jpeg = (n = 64) => Buffer.alloc(n, 0x41).toString('base64');

/** A one-route host that answers /screen/thumbnail however the test says. */
async function hostThatAnswers(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    reply(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

const json = (status, body) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('a good answer becomes a still', async () => {
  const host = await hostThatAnswers(json(200, { data: jpeg(), capturedAt: 1000, w: 320 }));
  try {
    const still = await fetchHostStill({ url: host.url, token: 'tok' });
    assert.ok(still);
    assert.equal(still.data, jpeg());
  } finally { await host.close(); }
});

test('the saved computer\'s own token is sent as a bearer header', async () => {
  // Not the app's one active connection: a card wants a picture of a machine
  // the phone is not connected to.
  const host = await hostThatAnswers(json(200, { data: jpeg(), capturedAt: 1000 }));
  try {
    await fetchHostStill({ url: host.url, token: 'other-machine-token' });
    assert.equal(host.seen[0].auth, 'Bearer other-machine-token');
    assert.equal(host.seen[0].url, '/screen/thumbnail');
  } finally { await host.close(); }
});

test('401, 429 and 503 are all just "no picture"', async () => {
  for (const status of [401, 429, 503, 500, 404]) {
    const host = await hostThatAnswers(json(status, { error: 'nope' }));
    try {
      assert.equal(await fetchHostStill({ url: host.url, token: 'tok' }), null, `status ${status}`);
    } finally { await host.close(); }
  }
});

test('a host that answers something that is not JSON is "no picture"', async () => {
  const host = await hostThatAnswers((_req, res) => { res.writeHead(200); res.end('<html>'); });
  try {
    assert.equal(await fetchHostStill({ url: host.url, token: 'tok' }), null);
  } finally { await host.close(); }
});

test('a host that never answers gives up on its own short deadline', async () => {
  const host = await hostThatAnswers(() => { /* hang forever */ });
  try {
    const started = Date.now();
    assert.equal(await fetchHostStill({ url: host.url, token: 'tok' }, undefined, 120), null);
    assert.ok(Date.now() - started < 3000, 'the deadline should have fired');
  } finally { await host.close(); }
});

test('an already-aborted caller never reaches the host', async () => {
  const host = await hostThatAnswers(json(200, { data: jpeg(), capturedAt: 1 }));
  try {
    const controller = new AbortController();
    controller.abort();
    assert.equal(await fetchHostStill({ url: host.url, token: 'tok' }, controller.signal), null);
    assert.equal(host.seen.length, 0);
  } finally { await host.close(); }
});

test('an unreachable address is "no picture", not a thrown error', async () => {
  // Port 1 on loopback: nothing listens, and the connect fails immediately.
  assert.equal(await fetchHostStill({ url: 'http://127.0.0.1:1', token: 'tok' }, undefined, 500), null);
});

// ---- parsing untrusted bodies --------------------------------------------

test('parseHostStill refuses a body with no usable payload', () => {
  assert.equal(parseHostStill(null), null);
  assert.equal(parseHostStill('a string'), null);
  assert.equal(parseHostStill({}), null);
  assert.equal(parseHostStill({ data: '' }), null);
  assert.equal(parseHostStill({ data: 42 }), null);
});

test('parseHostStill refuses a payload that is not base64', () => {
  assert.equal(parseHostStill({ data: '<script>alert(1)</script>' }), null);
  assert.equal(parseHostStill({ data: 'not base64!!' }), null);
});

test('parseHostStill refuses a payload over the phone\'s own ceiling', () => {
  // Independent of the host's cap: a host that is old, modified or simply
  // wrong must not be able to push an arbitrary blob into this app's memory.
  assert.equal(parseHostStill({ data: 'A'.repeat(MAX_STILL_BASE64 + 4) }), null);
  assert.ok(parseHostStill({ data: 'A'.repeat(MAX_STILL_BASE64) }));
});

test('parseHostStill clamps an implausible host clock to now', () => {
  const now = 1_000_000;
  assert.equal(parseHostStill({ data: jpeg(), capturedAt: now + 10 * 60_000 }, now).capturedAt, now);
  assert.equal(parseHostStill({ data: jpeg(), capturedAt: -5 }, now).capturedAt, now);
  assert.equal(parseHostStill({ data: jpeg(), capturedAt: 'soon' }, now).capturedAt, now);
  assert.equal(parseHostStill({ data: jpeg(), capturedAt: now - 3000 }, now).capturedAt, now - 3000);
});
