import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAILSCALE_APP_URL,
  TAILSCALE_STORE_URL,
  planTailnetUpgrade,
  readTailnetProbe,
  tailnetUrlFrom,
} from './tailnet.ts';

const lan = { kind: 'lan', url: 'http://192.168.0.81:8787' };
const ts = { kind: 'tailscale', url: 'http://100.108.50.23:8787' };
const magic = { kind: 'magicdns', url: 'http://mac.tail1234.ts.net:8787' };

const host = (extra = {}) => ({ ok: true, addresses: [lan, ts], ...extra });

// ---- tailnetUrlFrom -------------------------------------------------------

test('picks the tailscale address out of the advertised list', () => {
  assert.equal(tailnetUrlFrom(host()), ts.url);
});

test('falls back to MagicDNS when there is no literal tailnet address', () => {
  assert.equal(tailnetUrlFrom({ ok: true, addresses: [lan, magic] }), magic.url);
});

test('prefers the literal tailnet address over MagicDNS', () => {
  // MagicDNS needs name resolution and is the piece most often turned off.
  assert.equal(tailnetUrlFrom({ ok: true, addresses: [magic, ts] }), ts.url);
});

test('a LAN-only host offers nothing', () => {
  assert.equal(tailnetUrlFrom({ ok: true, addresses: [lan] }), null);
});

test('an older host with no address list does not throw', () => {
  assert.equal(tailnetUrlFrom({ ok: true }), null);
});

test('an advertised address with no url is ignored', () => {
  assert.equal(tailnetUrlFrom({ ok: true, addresses: [{ kind: 'tailscale', url: '' }] }), null);
});

// ---- planTailnetUpgrade ---------------------------------------------------

test('a host that already pairs over the tailnet needs no upgrade', () => {
  assert.deepEqual(planTailnetUpgrade(host({ pairing: 'tailnet' }), lan.url), { kind: 'ready' });
});

test('a LAN check on a tailnet-capable host upgrades to the tailnet address', () => {
  assert.deepEqual(planTailnetUpgrade(host({ pairing: 'code' }), lan.url), {
    kind: 'upgrade',
    url: ts.url,
  });
});

test('a LAN-only host has no upgrade to offer', () => {
  const check = { ok: true, pairing: 'code', addresses: [lan] };
  assert.deepEqual(planTailnetUpgrade(check, lan.url), { kind: 'unavailable' });
});

test('does not re-check the address it just checked', () => {
  // Same host, written differently — re-checking costs a round trip and can
  // only return what we already have.
  const variants = ['100.108.50.23:8787', 'http://100.108.50.23', '100.108.50.23/'];
  for (const written of variants) {
    assert.deepEqual(
      planTailnetUpgrade(host({ pairing: 'code' }), written),
      { kind: 'unavailable' },
      `should not upgrade when already on ${written}`,
    );
  }
});

test('an older host that reports no pairing mode still gets the upgrade', () => {
  // Absent `pairing` means an older host; trying the tailnet address is free
  // and the code screen is still there if it fails.
  assert.deepEqual(planTailnetUpgrade(host(), lan.url), { kind: 'upgrade', url: ts.url });
});

// ---- readTailnetProbe -----------------------------------------------------

test('a tailnet address that pairs without a code is the path to take', () => {
  assert.deepEqual(readTailnetProbe(ts.url, { ok: true, pairing: 'tailnet' }), {
    kind: 'paired-path',
    url: ts.url,
  });
});

test('an unreachable tailnet address means Tailscale is off on this phone', () => {
  // The host answered on its LAN address moments ago, so it is not down.
  assert.deepEqual(readTailnetProbe(ts.url, { ok: false, error: 'timed out' }), {
    kind: 'tailscale-off',
  });
});

test('reachable but still wanting a code falls back to the digits', () => {
  assert.deepEqual(readTailnetProbe(ts.url, { ok: true, pairing: 'code' }), {
    kind: 'code-required',
  });
});

// ---- links ----------------------------------------------------------------

test('the Tailscale links are the app scheme and the store page', () => {
  assert.equal(TAILSCALE_APP_URL, 'tailscale://');
  assert.match(TAILSCALE_STORE_URL, /^https:\/\/apps\.apple\.com\//);
});
