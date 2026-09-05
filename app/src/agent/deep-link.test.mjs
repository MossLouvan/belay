// Tests for the pure notification deep-link logic: parsing
// `belay://agent?host=<hostId>&session=<id>`, deciding what the app should do
// with it, and settling a pending open once a host switch resolves.
//
//   cd app && node --test src/agent/deep-link.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAgentLink, planAgentLink, sessionKnown, settlePendingOpen,
} from './deep-link.ts';

// ---- parseAgentLink --------------------------------------------------------

test('parseAgentLink accepts the exact URL the host puts in a notification', () => {
  assert.deepEqual(
    parseAgentLink('belay://agent?host=da771aad-caa5-4be3-bbbc-01ae4a36d02b&session=s_42'),
    { hostId: 'da771aad-caa5-4be3-bbbc-01ae4a36d02b', sessionId: 's_42' },
  );
});

test('parseAgentLink accepts the pre-rename tether scheme', () => {
  // Notifications sent before the rename must still land; the shim is load-bearing.
  assert.deepEqual(
    parseAgentLink('tether://agent?host=h1&session=s1'),
    { hostId: 'h1', sessionId: 's1' },
  );
});

test('parseAgentLink accepts the pathname form some URL parsers produce', () => {
  assert.deepEqual(
    parseAgentLink('belay:///agent?host=h1&session=s1'),
    { hostId: 'h1', sessionId: 's1' },
  );
});

test('parseAgentLink decodes percent-encoded values', () => {
  assert.deepEqual(
    parseAgentLink('belay://agent?host=h%2F1&session=s%201'),
    { hostId: 'h/1', sessionId: 's 1' },
  );
});

test('parseAgentLink tolerates surrounding whitespace', () => {
  assert.deepEqual(
    parseAgentLink('  belay://agent?host=h1&session=s1\n'),
    { hostId: 'h1', sessionId: 's1' },
  );
});

test('parseAgentLink rejects everything that is not an agent link', () => {
  const rejected = [
    '', 'not a url', 'https://agent?host=h&session=s',
    'belay://pair?v=1&id=x&c=123456&a=http://x', // a pairing QR, not ours
    'belay://agent', // no params at all
    'belay://agent?host=h1', // missing session
    'belay://agent?session=s1', // missing host
    'belay://agent?host=&session=s1', // empty host
    'belay://agent?host=h1&session=', // empty session
    'mailto://agent?host=h1&session=s1',
  ];
  for (const raw of rejected) {
    assert.equal(parseAgentLink(raw), null, `should reject: ${JSON.stringify(raw)}`);
  }
});

// ---- planAgentLink ---------------------------------------------------------

const device = (id, url) => ({
  id,
  label: id,
  platform: 'darwin',
  addresses: [{ kind: 'lan', url }],
  token: 't',
  addedAt: 0,
});

const link = { hostId: 'mac', sessionId: 's1' };

test('planAgentLink opens directly when the link names the active computer', () => {
  const devices = [device('mac', 'http://10.0.0.2:8443'), device('pc', 'http://10.0.0.3:8443')];
  assert.deepEqual(planAgentLink(link, devices, 'mac'), { kind: 'open', sessionId: 's1' });
});

test('planAgentLink switches first when the link names another saved computer', () => {
  const devices = [device('mac', 'http://10.0.0.2:8443'), device('pc', 'http://10.0.0.3:8443')];
  assert.deepEqual(
    planAgentLink(link, devices, 'pc'),
    { kind: 'switch', hostId: 'mac', sessionId: 's1' },
  );
});

test('planAgentLink matches on the stable host id, never on an address', () => {
  // Same address as the active computer, different id: still a switch — the
  // id is the identity, the URL is just where it happened to answer last.
  const devices = [device('mac', 'http://10.0.0.2:8443'), device('pc', 'http://10.0.0.2:8443')];
  assert.deepEqual(
    planAgentLink(link, devices, 'pc'),
    { kind: 'switch', hostId: 'mac', sessionId: 's1' },
  );
});

test('planAgentLink reports an unpaired computer honestly', () => {
  const devices = [device('pc', 'http://10.0.0.3:8443')];
  assert.deepEqual(planAgentLink(link, devices, 'pc'), { kind: 'host-not-found', hostId: 'mac' });
});

test('planAgentLink handles no saved computers and no active computer', () => {
  assert.deepEqual(planAgentLink(link, [], null), { kind: 'host-not-found', hostId: 'mac' });
});

// ---- sessionKnown ----------------------------------------------------------

test('sessionKnown is optimistic while the list is unknown', () => {
  // A failed or not-yet-run fetch must not block the open: the session view
  // has its own honest error surface.
  assert.equal(sessionKnown(null, 's1'), true);
});

test('sessionKnown checks the fetched list', () => {
  const sessions = [{ id: 's1' }, { id: 's2' }];
  assert.equal(sessionKnown(sessions, 's2'), true);
  assert.equal(sessionKnown(sessions, 's9'), false);
  assert.equal(sessionKnown([], 's1'), false);
});

// ---- settlePendingOpen -----------------------------------------------------

const pending = { hostId: 'mac', sessionId: 's1' };

test('settlePendingOpen opens once the named computer is connected', () => {
  assert.equal(settlePendingOpen(pending, 'mac', 'connected'), 'open');
});

test('settlePendingOpen keeps waiting while the switch is in flight', () => {
  assert.equal(settlePendingOpen(pending, 'mac', 'connecting'), 'wait');
});

test('settlePendingOpen gives up when the computer cannot be reached', () => {
  // The agent tab is already showing the honest unreachable state; a session
  // that surprise-opens minutes later after a manual retry would be worse.
  assert.equal(settlePendingOpen(pending, 'mac', 'unreachable'), 'drop');
});

test('settlePendingOpen gives up when the user moved to another computer', () => {
  assert.equal(settlePendingOpen(pending, 'pc', 'connected'), 'drop');
  assert.equal(settlePendingOpen(pending, null, 'idle'), 'drop');
});

test('settlePendingOpen gives up on idle — the computer was forgotten mid-switch', () => {
  assert.equal(settlePendingOpen(pending, 'mac', 'idle'), 'drop');
});
