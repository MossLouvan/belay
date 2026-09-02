// Outer wire protocol: every frame off the public internet goes through
// parseClientFrame before any handler sees it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseClientFrame, MAX_FRAME_BYTES } from '../src/protocol.js';
import { validateSignal, SIGNAL_LIMITS } from '../src/signal.js';
import { loadConfig } from '../src/config.js';

const MAILBOX = 'mbox-0001-abcdef';

test('parses each legal frame type', () => {
  const announce = parseClientFrame(JSON.stringify({ v: 1, type: 'announce', mailboxId: MAILBOX, seq: 1 }));
  assert.equal(announce.ok && announce.frame.type === 'announce', true);

  const lookup = parseClientFrame(JSON.stringify({ v: 1, type: 'lookup', mailboxId: MAILBOX }));
  assert.equal(lookup.ok && lookup.frame.type === 'lookup', true);

  const attach = parseClientFrame(JSON.stringify({ v: 1, type: 'attach', mailboxId: MAILBOX, side: 'host' }));
  assert.equal(attach.ok && attach.frame.type === 'attach', true);

  const signal = parseClientFrame(
    JSON.stringify({ v: 1, type: 'signal', message: { kind: 'offer', sessionId: 's1', sdp: 'v=0' } }),
  );
  assert.equal(signal.ok && signal.frame.type === 'signal', true);

  const turn = parseClientFrame(JSON.stringify({ v: 1, type: 'turn', sessionId: 's1' }));
  assert.equal(turn.ok && turn.frame.type === 'turn', true);
});

test('rejects non-text, oversized, non-JSON, unversioned and unknown frames', () => {
  assert.equal(parseClientFrame(Buffer.from('x') as unknown as string).ok, false);
  assert.equal(parseClientFrame('x'.repeat(MAX_FRAME_BYTES + 1)).ok, false);
  assert.equal(parseClientFrame('not json').ok, false);
  assert.equal(parseClientFrame('null').ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ type: 'lookup', mailboxId: MAILBOX })).ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ v: 2, type: 'lookup', mailboxId: MAILBOX })).ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ v: 1, type: 'shell', cmd: 'rm -rf /' })).ok, false);
});

test('invalid inner payloads are rejected at the boundary', () => {
  assert.equal(parseClientFrame(JSON.stringify({ v: 1, type: 'attach', mailboxId: MAILBOX, side: 'admin' })).ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ v: 1, type: 'attach', mailboxId: 'x' })).ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ v: 1, type: 'signal', message: { kind: 'exec' } })).ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ v: 1, type: 'turn', sessionId: 'a b' })).ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ v: 1, type: 'announce', mailboxId: MAILBOX, seq: 'one' })).ok, false);
});

test('signal validator mirrors the host relay contract (spot checks)', () => {
  // Keep the two validators honest with each other: shared caps and rules
  // exercised on identical inputs. Full behavior is pinned host-side in
  // server/test/webrtc-relay.test.ts.
  assert.equal(SIGNAL_LIMITS.maxSdpBytes, 64 * 1024);
  assert.equal(validateSignal({ kind: 'offer', sessionId: 's', sdp: 'v=0' }).ok, true);
  assert.equal(validateSignal({ kind: 'offer', sessionId: 's', sdp: 'x'.repeat(64 * 1024 + 1) }).ok, false);
  assert.equal(validateSignal({ kind: 'ice', sessionId: 's', candidate: 'x'.repeat(1025) }).ok, false);
  assert.equal(validateSignal({ kind: 'offer', sessionId: 's', sdp: 'v=0', seal: 'x'.repeat(513) }).ok, false);
  const sealed = validateSignal({ kind: 'offer', sessionId: 's', sdp: 'v=0', seal: 'v1.1.aa.bb' });
  assert.equal(sealed.ok && sealed.message.seal === 'v1.1.aa.bb', true);
});

test('config: fails fast without a strong secret or TURN urls', () => {
  const good = {
    BELAY_TURN_SECRET: 's'.repeat(64),
    BELAY_TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp',
  };
  assert.equal(loadConfig(good).ok, true);
  assert.equal(loadConfig({}).ok, false);
  assert.equal(loadConfig({ ...good, BELAY_TURN_SECRET: 'weak' }).ok, false);
  assert.equal(loadConfig({ ...good, BELAY_TURN_URLS: '' }).ok, false);
  assert.equal(loadConfig({ ...good, BELAY_TURN_URLS: 'http://not-turn' }).ok, false);
  assert.equal(loadConfig({ ...good, BELAY_RENDEZVOUS_PORT: '99999' }).ok, false);

  const parsed = loadConfig(good);
  if (parsed.ok) {
    assert.equal(parsed.config.port, 8790);
    assert.deepEqual([...parsed.config.turnUrls], [
      'turn:turn.example.com:3478?transport=udp',
      'turns:turn.example.com:443?transport=tcp',
    ]);
  }
});
