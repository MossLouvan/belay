// The react-native-webrtc PeerAdapter mapping, driven against a FAKE peer
// connection — the pure half that is verifiable with no native module and no
// phone. (The real ICE/SRTP/media is hardware-gated; see peer-adapter.ts.)
//
//   cd app && node --test src/stream/webrtc/peer-adapter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPeerAdapter, dataChannelInit, mapConnectionState } from './peer-adapter.ts';
import { CHANNELS } from './channels.ts';

/** A structural RTCPeerConnection stand-in that records every call and lets a
 *  test fire its events. */
function fakePeerConnection() {
  const listeners = new Map();
  const senders = [];
  const channels = [];
  return {
    calls: [],
    channels,
    senders,
    listeners,
    async createOffer() { this.calls.push('createOffer'); return { type: 'offer', sdp: 'OFFER-SDP' }; },
    async createAnswer() { this.calls.push('createAnswer'); return { type: 'answer', sdp: 'ANSWER-SDP' }; },
    async setLocalDescription(d) { this.calls.push(`setLocal:${d.type}`); },
    async setRemoteDescription(d) { this.calls.push(`setRemote:${d.type}:${d.sdp}`); },
    async addIceCandidate(c) { this.calls.push(`addIce:${c.candidate}`); },
    createDataChannel(label, init) {
      const ch = { label, init, sent: [], closed: false, send(d) { this.sent.push(d); }, close() { this.closed = true; } };
      channels.push(ch);
      return ch;
    },
    getSenders() { return senders; },
    addEventListener(type, cb) { listeners.set(type, cb); },
    connectionState: 'new',
    close() { this.calls.push('close'); },
    fire(type, event) { listeners.get(type)?.(event); },
  };
}

function setup() {
  const pc = fakePeerConnection();
  const sent = [];
  const states = [];
  const adapter = createPeerAdapter({
    pc,
    sessionId: 'sid',
    send: (m) => sent.push(m),
    onConnectionState: (s) => states.push(s),
  });
  return { pc, sent, states, adapter };
}

test('opens exactly the channels from channels.ts with the right reliability', () => {
  const { pc } = setup();
  const byLabel = Object.fromEntries(pc.channels.map((c) => [c.label, c.init]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['audio', 'control', 'cursor', 'input']);
  // cursor and audio are the unreliable, unordered channels.
  assert.deepEqual(byLabel.cursor, { ordered: false, maxRetransmits: 0 });
  assert.deepEqual(byLabel.audio, { ordered: false, maxRetransmits: 0 });
  // input and control are fully reliable (no maxRetransmits key).
  assert.deepEqual(byLabel.input, { ordered: true });
  assert.deepEqual(byLabel.control, { ordered: true });
});

test('sendBytesOn sends raw bytes on the audio channel, no JSON wrapper, no fallback', () => {
  const { pc, adapter } = setup();
  const byLabel = Object.fromEntries(pc.channels.map((c) => [c.label, c]));
  const bytes = new Uint8Array([0xa5, 1, 2, 3]);
  adapter.sendBytesOn('audio', bytes);
  assert.equal(byLabel.audio.sent.length, 1);
  assert.equal(byLabel.audio.sent[0], bytes, 'bytes pass through untouched');
  assert.equal(byLabel.control.sent.length, 0, 'audio never spills onto control');
});

test('dataChannelInit reflects each spec faithfully', () => {
  assert.deepEqual(dataChannelInit(CHANNELS.cursor), { ordered: false, maxRetransmits: 0 });
  assert.deepEqual(dataChannelInit(CHANNELS.input), { ordered: true });
});

test('createOffer sets the local description and returns the sdp string', async () => {
  const { pc, adapter } = setup();
  const sdp = await adapter.createOffer();
  assert.equal(sdp, 'OFFER-SDP');
  assert.deepEqual(pc.calls, ['createOffer', 'setLocal:offer']);
});

test('setRemoteDescription and addIceCandidate map to single pc calls', async () => {
  const { pc, adapter } = setup();
  await adapter.setRemoteDescription('REMOTE', 'answer');
  await adapter.addIceCandidate('candidate:1 1 udp 1 1.2.3.4 5 typ host');
  assert.ok(pc.calls.includes('setRemote:answer:REMOTE'));
  assert.ok(pc.calls.includes('addIce:candidate:1 1 udp 1 1.2.3.4 5 typ host'));
});

test('local ICE candidates are relayed over the signaling transport', () => {
  const { pc, sent } = setup();
  pc.fire('icecandidate', { candidate: { candidate: 'candidate:local' } });
  pc.fire('icecandidate', { candidate: null }); // end-of-gathering: relayed as nothing
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { kind: 'ice', candidate: 'candidate:local', sessionId: 'sid' });
});

test('connection-state changes are mapped and reported to the controller', () => {
  const { pc, states } = setup();
  pc.connectionState = 'connecting';
  pc.fire('connectionstatechange', {}); // ignored (not a controller state)
  pc.connectionState = 'connected';
  pc.fire('connectionstatechange', {});
  pc.connectionState = 'failed';
  pc.fire('connectionstatechange', {});
  assert.deepEqual(states, ['connected', 'failed']);
});

test('mapConnectionState collapses the pc states to the controller subset', () => {
  assert.equal(mapConnectionState('connected'), 'connected');
  assert.equal(mapConnectionState('failed'), 'failed');
  assert.equal(mapConnectionState('new'), null);
  assert.equal(mapConnectionState('connecting'), null);
});

test('setBitrate writes maxBitrate onto the video sender, ignoring absent senders', async () => {
  const { pc, adapter } = setup();
  // No sender yet: must be a safe no-op.
  assert.doesNotThrow(() => adapter.setBitrate(3_000_000));

  let applied = null;
  pc.senders.push({
    track: { kind: 'video' },
    getParameters() { return { encodings: [{}] }; },
    async setParameters(p) { applied = p; },
  });
  adapter.setBitrate(4_500_000);
  await Promise.resolve();
  assert.equal(applied.encodings[0].maxBitrate, 4_500_000);
});

test('sendOn serializes onto the named channel', () => {
  const { pc, adapter } = setup();
  const byLabel = Object.fromEntries(pc.channels.map((c) => [c.label, c]));
  adapter.sendOn('input', 'key', { vk: 65 });
  adapter.sendOn('cursor', 'move', { x: 1, y: 2 });
  assert.deepEqual(JSON.parse(byLabel.input.sent[0]), { kind: 'key', payload: { vk: 65 } });
  assert.deepEqual(JSON.parse(byLabel.cursor.sent[0]), { kind: 'move', payload: { x: 1, y: 2 } });
});

test('teardown closes every channel and the peer connection', () => {
  const { pc, adapter } = setup();
  adapter.teardown('user left');
  assert.ok(pc.channels.every((c) => c.closed), 'all channels closed');
  assert.ok(pc.calls.includes('close'), 'peer connection closed');
});
