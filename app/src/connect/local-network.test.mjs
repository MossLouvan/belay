// cd app && node --test src/connect/local-network.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLanUrl, isLocalNetworkBlocked } from './local-network.ts';

test('LAN addresses are the ones the permission governs', () => {
  for (const url of [
    'https://192.168.1.30:8787',
    'http://10.0.0.5:8787',
    'https://172.16.4.2:8787',
    'https://172.31.255.1',
    'http://169.254.10.1:8787',
    'https://moss-mac.local:8787',
    'https://[fe80::1]:8787',
    'https://[fd12:3456::1]:8787',
  ]) assert.equal(isLanUrl(url), true, url);
});

test('tailnet, public and junk addresses are not LAN', () => {
  for (const url of [
    'http://100.64.10.40:8787',
    'http://mac.tail1234.ts.net:8787',
    'https://api.gobelay.com/v1',
    'https://172.32.0.1',
    'https://8.8.8.8',
    'not a url',
    '',
  ]) assert.equal(isLanUrl(url), false, url);
});

const lan = ['https://192.168.1.30:8787'];

test('a denied status on iOS explains a LAN failure', () => {
  assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: lan, error: 'Network request failed', status: 'denied' }), true);
  // No error text at all (the certificate probe returns null) still counts.
  assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: lan, status: 'denied' }), true);
});

test("iOS's own policy-denied error text counts even when the status is unknown", () => {
  for (const error of [
    'The operation couldn’t be completed. (Local network prohibited)',
    'NWError -65570: PolicyDenied',
    'DNSServiceErr_PolicyDenied',
  ]) assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: lan, error, status: 'unknown' }), true, error);
});

test('granted or unknown with an ordinary failure keeps the ordinary diagnosis', () => {
  assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: lan, error: 'Network request failed', status: 'granted' }), false);
  assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: lan, error: 'timed out', status: 'unknown' }), false);
  assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: lan }), false);
});

test('only a LAN address can be blocked by the permission', () => {
  assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: ['http://100.64.10.40:8787'], status: 'denied' }), false);
  assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: ['https://api.gobelay.com/v1'], error: 'Local network prohibited' }), false);
  // A scanned QR lists several; one LAN address among them is enough.
  assert.equal(isLocalNetworkBlocked({ platform: 'ios', urls: ['http://100.64.10.40:8787', ...lan], status: 'denied' }), true);
});

test('Android and web never have the permission', () => {
  for (const platform of ['android', 'web']) {
    assert.equal(isLocalNetworkBlocked({ platform, urls: lan, error: 'Local network prohibited', status: 'denied' }), false);
  }
});
