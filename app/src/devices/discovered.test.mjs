// The tailnet-discovery logic the phone owns: which found computers are new,
// how to try to reach one, and what an empty result honestly says.
//
//   cd app && node --test src/devices/discovered.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newlyDiscovered, candidateUrls, pairNeedsCode, summarizeDiscovery,
} from './discovered.ts';

const pcHost = {
  id: 'pc-uuid',
  label: 'Windows PC',
  platform: 'win32',
  tailnetName: 'DESKTOP-BB4FRER',
  url: 'http://100.82.170.69:8787',
  addresses: [
    { kind: 'lan', url: 'http://192.168.1.9:8787' },
    { kind: 'tailscale', url: 'http://100.82.170.69:8787' },
  ],
};

const savedMac = {
  id: 'mac-uuid',
  label: 'MacBook Air',
  platform: 'darwin',
  addresses: [{ kind: 'tailscale', url: 'http://100.98.1.1:8787' }],
  token: 't',
  addedAt: 1,
};

function reply(overrides = {}) {
  return { tailscale: true, peers: 1, hosts: [pcHost], ...overrides };
}

// ---- filtering -----------------------------------------------------------

test('a host not in the saved list is offered', () => {
  assert.deepEqual(newlyDiscovered([pcHost], [savedMac]), [pcHost]);
});

test('a host already saved by id is not offered again', () => {
  const savedPc = { ...savedMac, id: 'pc-uuid' };
  assert.deepEqual(newlyDiscovered([pcHost], [savedPc]), []);
});

test('a legacy-id computer is recognised by address overlap, not id', () => {
  // Saved before hosts reported ids: the id will never match, the URL will.
  const legacy = {
    ...savedMac,
    id: 'legacy:http://192.168.1.9:8787',
    addresses: [{ kind: 'lan', url: 'http://192.168.1.9:8787' }],
  };
  assert.deepEqual(newlyDiscovered([pcHost], [legacy]), []);
});

// ---- how to reach it -----------------------------------------------------

test('candidates keep the advertised order and never duplicate the proven URL', () => {
  assert.deepEqual(candidateUrls(pcHost), [
    'http://192.168.1.9:8787',
    'http://100.82.170.69:8787',
  ]);
});

test('a proven URL the host does not advertise is appended', () => {
  const proxied = { ...pcHost, url: 'http://100.82.170.69:9999' };
  assert.deepEqual(candidateUrls(proxied), [
    'http://192.168.1.9:8787',
    'http://100.82.170.69:8787',
    'http://100.82.170.69:9999',
  ]);
});

// ---- failure classification ----------------------------------------------

test('the code-demanded refusal is told apart from every other failure', () => {
  assert.equal(pairNeedsCode('invalid or expired pairing code'), true);
  assert.equal(pairNeedsCode('the computer did not answer in time'), false);
});

// ---- honest empty states (docs/DESIGN.md §11.4) --------------------------

test('fresh hosts need no summary', () => {
  assert.equal(summarizeDiscovery(reply(), 1, 'MacBook Air'), null);
});

test('tailscale down names the computer that could not ask, and why', () => {
  const s = summarizeDiscovery(
    reply({ tailscale: false, detail: 'the tailscale CLI did not answer', peers: 0, hosts: [] }),
    0,
    'MacBook Air',
  );
  assert.equal(s.state, 'Tailscale unavailable');
  assert.match(s.message, /MacBook Air could not ask Tailscale/);
  assert.match(s.message, /the tailscale CLI did not answer/);
});

test('no peers and peers-without-Belay are different states', () => {
  const none = summarizeDiscovery(reply({ peers: 0, hosts: [] }), 0, 'Mac');
  assert.equal(none.state, 'No other devices');

  const noBelay = summarizeDiscovery(reply({ peers: 2, hosts: [] }), 0, 'Mac');
  assert.equal(noBelay.state, 'No Belay hosts found');
  assert.match(noBelay.message, /2 other devices are on your tailnet/);
  assert.match(noBelay.message, /Start the host agent/);

  const one = summarizeDiscovery(reply({ peers: 1, hosts: [] }), 0, 'Mac');
  assert.match(one.message, /One other device is/);
});

test('hosts found but all already saved says so', () => {
  const s = summarizeDiscovery(reply(), 0, 'Mac');
  assert.equal(s.state, 'All added');
  assert.match(s.message, /already in your list/);
});
