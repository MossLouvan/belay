import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PORT,
  EXAMPLE_TAILSCALE_ADDRESS,
  TAILSCALE_PREFIX,
  addressFeedback,
  isIPv4,
  isMagicDnsName,
  isTailscaleIPv4,
  looksLikeIPv4Draft,
  looksLikePairLink,
  parseAddress,
} from './address-input.ts';

const ok = (input) => {
  const parsed = parseAddress(input);
  assert.equal(parsed.kind, 'ok', `${JSON.stringify(input)} should parse: ${JSON.stringify(parsed)}`);
  return parsed;
};

const rejected = (input) => {
  const parsed = parseAddress(input);
  assert.equal(parsed.kind, 'invalid', `${JSON.stringify(input)} should be rejected: ${JSON.stringify(parsed)}`);
  return parsed;
};

// ---- accepted forms ----------------------------------------------------------

test('a bare Tailscale IP gets http and the default port', () => {
  const parsed = ok('100.1.2.3');
  assert.equal(parsed.url, `http://100.1.2.3:${DEFAULT_PORT}`);
  assert.equal(parsed.host, '100.1.2.3');
  assert.equal(parsed.port, DEFAULT_PORT);
});

test('the example address is a Tailscale address', () => {
  const parsed = ok(EXAMPLE_TAILSCALE_ADDRESS);
  assert.equal(parsed.family, 'tailscale');
  assert.equal(parsed.url, `http://${EXAMPLE_TAILSCALE_ADDRESS}:8787`);
});

test('an explicit port is kept', () => {
  assert.equal(ok('100.1.2.3:8787').url, 'http://100.1.2.3:8787');
  assert.equal(ok('100.1.2.3:9000').url, 'http://100.1.2.3:9000');
  assert.equal(ok('100.1.2.3:9000').port, 9000);
});

test('a full http URL is accepted as-is', () => {
  assert.equal(ok('http://100.1.2.3:8787').url, 'http://100.1.2.3:8787');
  assert.equal(ok('HTTP://100.1.2.3').url, 'http://100.1.2.3:8787');
});

test('https keeps its scheme and does not get 8787 forced on it', () => {
  assert.equal(ok('https://100.1.2.3').url, 'https://100.1.2.3');
  assert.equal(ok('https://100.1.2.3:8443').url, 'https://100.1.2.3:8443');
});

test('a MagicDNS name is a tailnet address', () => {
  const parsed = ok('mosss-macbook-air.tail1234.ts.net');
  assert.equal(parsed.family, 'magicdns');
  assert.equal(parsed.url, 'http://mosss-macbook-air.tail1234.ts.net:8787');
});

test('MagicDNS names are lower-cased so the same computer is one address', () => {
  assert.equal(ok('Mosss-MacBook-Air.tail1234.ts.net').host, 'mosss-macbook-air.tail1234.ts.net');
});

test('trailing and leading whitespace from a sloppy copy is ignored', () => {
  assert.equal(ok('100.1.2.3 ').url, 'http://100.1.2.3:8787');
  assert.equal(ok('  100.1.2.3\n').url, 'http://100.1.2.3:8787');
  assert.equal(ok('\t100.1.2.3:8787 \n').url, 'http://100.1.2.3:8787');
});

test('a trailing slash or path is dropped — only the origin matters', () => {
  assert.equal(ok('http://100.1.2.3:8787/').url, 'http://100.1.2.3:8787');
  assert.equal(ok('100.1.2.3:8787/health').url, 'http://100.1.2.3:8787');
  assert.equal(ok('100.1.2.3/?x=1').url, 'http://100.1.2.3:8787');
});

test('a LAN address and a plain name still work, as the local fallback', () => {
  assert.equal(ok('192.168.1.20').family, 'lan');
  assert.equal(ok('192.168.1.20').url, 'http://192.168.1.20:8787');
  assert.equal(ok('pc.local').family, 'name');
  assert.equal(ok('pc.local').url, 'http://pc.local:8787');
  assert.equal(ok('localhost:8787').url, 'http://localhost:8787');
});

test('credentials are dropped from the URL but reported', () => {
  const parsed = ok('http://user:pass@100.1.2.3:8787');
  assert.equal(parsed.url, 'http://100.1.2.3:8787');
  assert.equal(parsed.hadCredentials, true);
  assert.equal(ok('100.1.2.3').hadCredentials, false);
});

test('the Tailscale family is the 100.64/10 range only', () => {
  assert.equal(ok('100.64.0.1').family, 'tailscale');
  assert.equal(ok('100.127.255.254').family, 'tailscale');
  assert.equal(ok('100.63.0.1').family, 'lan');
  assert.equal(ok('100.128.0.1').family, 'lan');
});

// ---- rejected forms ----------------------------------------------------------

test('nothing typed is empty, not an error', () => {
  assert.deepEqual(parseAddress(''), { kind: 'empty' });
  assert.deepEqual(parseAddress('   \n'), { kind: 'empty' });
});

test('spaces inside the address are rejected', () => {
  assert.match(rejected('100.1 .2.3').reason, /spaces/);
  assert.match(rejected('my computer').reason, /spaces/);
});

test('an octet out of range or too few octets is not an IP', () => {
  rejected('100.1.2.999');
  rejected('100.1.2');
  rejected('100.1.2.3.4');
  rejected('100..1.2');
});

test('a port out of range is rejected with the default named', () => {
  assert.match(rejected('100.1.2.3:0').reason, /8787/);
  assert.match(rejected('100.1.2.3:70000').reason, /port/);
});

test('garbage is rejected and the rejection shows the example', () => {
  assert.match(rejected('http://').reason, new RegExp(EXAMPLE_TAILSCALE_ADDRESS));
  rejected('not an address!');
  rejected('100.1.2.3:abc');
  rejected('.pc.local');
  rejected('pc.local.');
});

test('a pairing code alone is not an address', () => {
  rejected('123456');
});

// ---- classifiers --------------------------------------------------------------

test('isIPv4 / isTailscaleIPv4 / isMagicDnsName', () => {
  assert.equal(isIPv4('10.0.0.1'), true);
  assert.equal(isIPv4('10.0.0'), false);
  assert.equal(isIPv4('256.0.0.1'), false);
  assert.equal(isTailscaleIPv4('100.100.1.1'), true);
  assert.equal(isTailscaleIPv4('100.1.1.1'), false);
  assert.equal(isMagicDnsName('pc.tail1234.ts.net'), true);
  assert.equal(isMagicDnsName('pc.local'), false);
  assert.equal(looksLikeIPv4Draft('100.1'), true);
  assert.equal(looksLikeIPv4Draft('100.1a'), false);
});

// ---- live feedback ------------------------------------------------------------

test('nothing typed has nothing to say', () => {
  assert.equal(addressFeedback(''), null);
  assert.equal(addressFeedback('  '), null);
});

test('a Tailscale address is reassured in good', () => {
  assert.deepEqual(addressFeedback('100.101.102.103'), { tone: 'good', text: 'Looks like a Tailscale address' });
  assert.deepEqual(addressFeedback('100.101.102.103:8787 '), { tone: 'good', text: 'Looks like a Tailscale address' });
  assert.deepEqual(addressFeedback('http://100.64.0.9:8787'), { tone: 'good', text: 'Looks like a Tailscale address' });
  assert.equal(addressFeedback('pc.tail1234.ts.net').tone, 'good');
  assert.match(addressFeedback('pc.tail1234.ts.net').text, /Tailscale name/);
});

test('anything starting 100. reads as Tailscale while typing, even outside the /10', () => {
  assert.equal(addressFeedback('100.1.2.3').tone, 'good');
});

test('an IP heading somewhere else is told where Tailscale addresses start', () => {
  assert.deepEqual(addressFeedback('192.'), { tone: 'warn', text: 'Tailscale addresses start with 100.' });
  assert.deepEqual(addressFeedback('10.0'), { tone: 'warn', text: 'Tailscale addresses start with 100.' });
  assert.equal(addressFeedback('192.168.1.20').tone, 'warn');
  assert.match(addressFeedback('192.168.1.20').text, /start with 100\./);
});

test('a half-typed Tailscale address is encouraged, not corrected', () => {
  for (const draft of ['1', '10', '100', '100.', '100.1', '100.101.102', '100.101.102.']) {
    const fb = addressFeedback(draft);
    assert.equal(fb.tone, 'dim', draft);
    assert.match(fb.text, new RegExp(EXAMPLE_TAILSCALE_ADDRESS));
  }
  assert.ok(TAILSCALE_PREFIX.startsWith('100.'));
});

test('a plain name is explained, quietly', () => {
  assert.equal(addressFeedback('pc.local').tone, 'dim');
});

test('a rejection is spoken in bad with the reason', () => {
  const fb = addressFeedback('my computer');
  assert.equal(fb.tone, 'bad');
  assert.match(fb.text, /spaces/);
});

test('a pasted pairing link is recognised before any address parsing', () => {
  assert.equal(looksLikePairLink('belay://pair?v=1&c=000000'), true);
  assert.equal(looksLikePairLink(' tether:pair?x=1'), true);
  assert.equal(looksLikePairLink('100.1.2.3'), false);
  assert.equal(addressFeedback('belay://pair?v=1').tone, 'good');
  assert.match(addressFeedback('belay://pair?v=1').text, /Pairing link/);
});
