// Unit tests for the header connection summary.
//
//   cd app && node --test src/devices/summary.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions, only
// JSX-free modules imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connectionSummary, kindLabel, kindOfUrl, kindSpoken } from './summary.ts';

const mac = {
  id: 'mac-uuid',
  label: 'MacBook Air',
  platform: 'darwin',
  addresses: [
    { kind: 'lan', url: 'http://192.168.1.5:8787' },
    { kind: 'tailscale', url: 'http://100.101.102.103:8787' },
    { kind: 'magicdns', url: 'http://mac.tailnet.ts.net:8787' },
  ],
  token: 'mac-token',
  addedAt: 1000,
};

// ---- path labelling ------------------------------------------------------

test('each address kind has a short label and a spoken form', () => {
  assert.equal(kindLabel('lan'), 'LAN');
  assert.equal(kindLabel('tailscale'), 'Tailscale');
  assert.equal(kindLabel('relay'), 'Relay');
  assert.equal(kindSpoken('lan'), 'your local network');
  assert.equal(kindSpoken('relay'), 'a relay');
});

test('magicdns is described as Tailscale, not as a DNS scheme', () => {
  // The user chose Tailscale; MagicDNS is just how its names resolve. Showing
  // "MAGICDNS" in the header would name the mechanism, not the path.
  assert.equal(kindLabel('magicdns'), 'Tailscale');
  assert.equal(kindSpoken('magicdns'), 'Tailscale');
});

test('the winning URL is resolved to its saved kind, never guessed', () => {
  assert.equal(kindOfUrl(mac, 'http://192.168.1.5:8787'), 'lan');
  assert.equal(kindOfUrl(mac, 'http://100.101.102.103:8787'), 'tailscale');
  assert.equal(kindOfUrl(mac, 'http://unknown:8787'), null);
  assert.equal(kindOfUrl(mac, null), null);
});

// ---- the summary itself --------------------------------------------------

test('connected over the LAN reads name · LAN with a steady good dot', () => {
  const s = connectionSummary(mac, 'connected', 'http://192.168.1.5:8787');
  assert.equal(s.text, 'MacBook Air · LAN');
  assert.equal(s.status, 'good');
  assert.equal(s.pulse, false);
  assert.match(s.accessibilityLabel, /over your local network/);
});

test('connected over Tailscale names the tunnel', () => {
  const s = connectionSummary(mac, 'connected', 'http://100.101.102.103:8787');
  assert.equal(s.text, 'MacBook Air · Tailscale');
});

test('a winner that matches no saved address shows the name alone', () => {
  // Better to admit not knowing the path than to invent one.
  const s = connectionSummary(mac, 'connected', 'http://unknown:8787');
  assert.equal(s.text, 'MacBook Air');
  assert.equal(s.status, 'good');
});

test('connecting pulses and says so', () => {
  const s = connectionSummary(mac, 'connecting', null);
  assert.equal(s.text, 'MacBook Air · connecting');
  assert.equal(s.status, 'warn');
  assert.equal(s.pulse, true);
});

test('unreachable is bad and steady — a settled fact, not activity', () => {
  const s = connectionSummary(mac, 'unreachable', null);
  assert.equal(s.text, 'MacBook Air · unreachable');
  assert.equal(s.status, 'bad');
  assert.equal(s.pulse, false);
});

test('no active computer still names the way to My Computers', () => {
  const s = connectionSummary(undefined, 'idle', null);
  assert.equal(s.text, 'No computer');
  assert.equal(s.status, 'neutral');
  assert.match(s.accessibilityLabel, /My Computers/);
});

test('idle with a computer shows the name without claiming a connection', () => {
  const s = connectionSummary(mac, 'idle', null);
  assert.equal(s.text, 'MacBook Air');
  assert.equal(s.status, 'neutral');
});

test('every summary tells assistive tech where the tap goes', () => {
  const phases = ['idle', 'connecting', 'connected', 'unreachable'];
  for (const phase of phases) {
    const s = connectionSummary(mac, phase, 'http://192.168.1.5:8787');
    assert.match(s.accessibilityLabel, /Opens My Computers\.$/, phase);
  }
});
