// ICE classification: the direct-vs-relayed telemetry that sets unit economics.
//
//   cd app && node --test src/stream/webrtc/ice.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { candidateType, classifyPair, IceStats } from './ice.ts';

test('reads the type out of an SDP candidate line', () => {
  assert.equal(candidateType('candidate:1 1 udp 2130706431 192.168.1.4 54321 typ host'), 'host');
  assert.equal(candidateType('candidate:2 1 udp 1694498815 1.2.3.4 54321 typ srflx raddr 192.168.1.4 rport 54321'), 'srflx');
  assert.equal(candidateType('candidate:3 1 udp 41885439 5.6.7.8 54321 typ relay raddr 1.2.3.4 rport 54321'), 'relay');
});

test('reads the type out of an RTCIceCandidate-shaped object', () => {
  assert.equal(candidateType({ type: 'prflx' }), 'prflx');
  assert.equal(candidateType({ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ relay' }), 'relay');
});

test('unrecognized or missing input is unknown, never a throw', () => {
  assert.equal(candidateType(null), 'unknown');
  assert.equal(candidateType(''), 'unknown');
  assert.equal(candidateType('garbage with no typ'), 'unknown');
  assert.equal(candidateType({ type: 'weird' }), 'unknown');
});

test('a pair is relayed if EITHER end is a relay', () => {
  assert.equal(classifyPair('relay', 'host'), 'relayed');
  assert.equal(classifyPair('host', 'relay'), 'relayed');
  assert.equal(classifyPair('relay', 'relay'), 'relayed');
});

test('host-host is direct-local; a reflexive end is direct across NAT', () => {
  assert.equal(classifyPair('host', 'host'), 'direct-local');
  assert.equal(classifyPair('srflx', 'host'), 'direct-reflexive');
  assert.equal(classifyPair('srflx', 'srflx'), 'direct-reflexive');
  assert.equal(classifyPair('prflx', 'host'), 'direct-reflexive');
});

test('unknown propagates so a bad sample never inflates the direct ratio', () => {
  assert.equal(classifyPair('unknown', 'host'), 'unknown');
});

test('direct ratio ignores unknown sessions in the denominator', () => {
  const s = new IceStats();
  s.recordPair('host', 'host');       // direct
  s.recordPair('srflx', 'host');      // direct
  s.recordPair('relay', 'host');      // relayed
  s.record('unknown');                // excluded from the ratio
  assert.equal(s.directRatio(), 2 / 3);
});

test('no classified sessions yields null, not a divide-by-zero', () => {
  const s = new IceStats();
  s.record('unknown');
  assert.equal(s.directRatio(), null);
});
