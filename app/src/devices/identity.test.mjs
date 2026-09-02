// Unit tests for the host-identity guard on a raced probe.
//
//   cd app && node --test src/devices/identity.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostIdentityMatches } from './identity.ts';
import { raceAddresses } from './race.ts';

const noStagger = { staggerMs: 0, sleep: async () => {} };

test('a normal entry rejects a probe that reports a different real id', () => {
  // The regression: laptop A was saved as 'A-uuid'; laptop B now answers on
  // A's reused LAN address with its own id. B must not be accepted as A.
  assert.equal(hostIdentityMatches('A-uuid', 'B-uuid', false), false);
});

test('a normal entry accepts the machine that proves the same id', () => {
  assert.equal(hostIdentityMatches('A-uuid', 'A-uuid', false), true);
});

test('an absent reported id is accepted (older host reports none)', () => {
  assert.equal(hostIdentityMatches('A-uuid', undefined, false), true);
});

test('a legacy entry accepts any real id, so it can adopt one', () => {
  assert.equal(hostIdentityMatches('legacy:http://host:8787', 'real-uuid', true), true);
});

// ---- regression: the token must not follow a reused IP to a new machine ---
//
// Reproduces the repro end to end through the real racer, wired exactly as
// connectTo wires its probe. Laptop A was saved as 'A-uuid' at its LAN address;
// A is powered down and DHCP has handed that same IP to laptop B, which serves
// a /health that answers ok with B's own id. Before the fix the probe reported
// only { ok, hostId } and the winner's hostId was ignored, so B won and was
// handed A's token. With the guard folded into ok, B is a failed candidate and
// the race reports the computer as unreachable instead.

const savedDeviceId = 'A-uuid';
const reusedLanUrl = 'http://192.168.1.20:8787';

// Mirrors connectTo's probe: ok is gated on the identity guard.
const guardedProbe = (health) => async () => ({
  ok: health.ok && hostIdentityMatches(savedDeviceId, health.id, false),
  hostId: health.id,
});

test('regression: an impostor answering the reused IP is rejected, not connected', async () => {
  // B answers ok on A's old address, with B's own id.
  const impostor = guardedProbe({ ok: true, id: 'B-uuid' });
  const winner = await raceAddresses([{ url: reusedLanUrl }], impostor, noStagger);
  assert.equal(winner, null, 'the wrong machine must never win the race');
});

test('regression: the genuine host on the same address still connects', async () => {
  // A is back and answers with its own id — the ordinary happy path.
  const genuine = guardedProbe({ ok: true, id: savedDeviceId });
  const winner = await raceAddresses([{ url: reusedLanUrl }], genuine, noStagger);
  assert.equal(winner?.url, reusedLanUrl);
});
