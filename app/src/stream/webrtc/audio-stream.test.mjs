// Sender -> transport -> receiver, end to end over a fake transport: the push
// contract that will ride the `audio` data channel / the /ws/audio socket.
//
//   cd app && node --test src/stream/webrtc/audio-stream.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUDIO_FRAME_MS, AUDIO_SAMPLES_PER_FRAME, decodeAudioFrame } from './audio-frames.ts';
import { AudioReceiver, AudioSender } from './audio-stream.ts';

test('sender stamps consecutive seqs and advancing timestamps', () => {
  const sent = [];
  const sender = new AudioSender((b) => sent.push(b), 'opus', 100);
  sender.pushEncodedFrame(new Uint8Array([1]));
  sender.pushEncodedFrame(new Uint8Array([2]));
  sender.pushEncodedFrame(new Uint8Array([3]));

  const frames = sent.map((b) => decodeAudioFrame(b).frame);
  assert.deepEqual(frames.map((f) => f.seq), [100, 101, 102]);
  assert.deepEqual(frames.map((f) => f.timestamp), [0, 960, 1920]);
  assert.deepEqual(frames.map((f) => f.codec), ['opus', 'opus', 'opus']);
  assert.equal(sender.stats.framesSent, 3);
  assert.ok(sender.stats.bytesSent > 0);
});

test('sender seq wraps at u16 and timestamp wraps at u32', () => {
  const sent = [];
  const sender = new AudioSender((b) => sent.push(b), 'opus', 0xffff);
  sender.pushEncodedFrame(new Uint8Array([1]), 0xffffffff - 100); // pushes ts to near-wrap
  sender.pushEncodedFrame(new Uint8Array([2]), AUDIO_SAMPLES_PER_FRAME);
  const [a, b] = sent.map((x) => decodeAudioFrame(x).frame);
  assert.equal(a.seq, 0xffff);
  assert.equal(b.seq, 0, 'seq wrapped');
  assert.equal(b.timestamp, 0xffffffff - 100, 'second frame carries the pre-wrap total');
});

test('clean transport: everything sent is played, in order', () => {
  const receiver = new AudioReceiver();
  const sender = new AudioSender((bytes) => receiver.onWireBytes(bytes, now), 'opus');

  let now = 0;
  for (let i = 0; i < 10; i++) {
    sender.pushEncodedFrame(new Uint8Array([i]));
    now += AUDIO_FRAME_MS;
  }

  const played = [];
  for (let i = 0; i < 10; i++) {
    const action = receiver.tick();
    if (action.kind === 'play') played.push(action.frame.payload[0]);
  }
  assert.deepEqual(played, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(receiver.stats.concealed, 0);
  assert.equal(receiver.stats.malformed, 0);
});

test('lossy, reordering transport: playback stays ordered, gaps are concealed', () => {
  const receiver = new AudioReceiver();
  const wire = [];
  const sender = new AudioSender((bytes) => wire.push(bytes), 'opus');
  for (let i = 0; i < 8; i++) sender.pushEncodedFrame(new Uint8Array([i]));

  // Drop frame 3; swap 5 and 6 in flight.
  const delivered = [wire[0], wire[1], wire[2], wire[4], wire[6], wire[5], wire[7]];
  let now = 0;
  for (const bytes of delivered) {
    assert.equal(receiver.onWireBytes(bytes, now), 'buffered');
    now += AUDIO_FRAME_MS;
  }

  const played = [];
  let conceals = 0;
  for (let i = 0; i < 9; i++) {
    const action = receiver.tick();
    if (action.kind === 'play') played.push(action.frame.payload[0]);
    if (action.kind === 'conceal') conceals += 1;
  }
  assert.deepEqual(played, [0, 1, 2, 4, 5, 6, 7], 'ordered despite the swap, 3 missing');
  assert.equal(conceals, 1, 'the one lost frame cost one concealment');
});

test('garbage on the wire is counted, never thrown', () => {
  const receiver = new AudioReceiver();
  assert.equal(receiver.onWireBytes(new Uint8Array([1, 2, 3]), 0), 'malformed');
  assert.equal(receiver.onWireBytes(new TextEncoder().encode('{"kind":"ping"}'), 0), 'malformed');
  assert.equal(receiver.stats.malformed, 2);
});

test('a capture restart (new sender, distant seq base) resyncs the receiver', () => {
  const receiver = new AudioReceiver();
  let now = 0;
  const s1 = new AudioSender((b) => receiver.onWireBytes(b, now), 'opus', 10);
  for (let i = 0; i < 4; i++) { s1.pushEncodedFrame(new Uint8Array([1])); now += AUDIO_FRAME_MS; }
  for (let i = 0; i < 4; i++) receiver.tick(); // playout underway

  const s2 = new AudioSender((b) => receiver.onWireBytes(b, now), 'opus', 40_000);
  s2.pushEncodedFrame(new Uint8Array([2]));
  assert.equal(receiver.stats.resets, 1, 'the distant seq base reads as a restart');
});

test('receiver stats expose depth and target delay for the overlay', () => {
  const receiver = new AudioReceiver();
  const sender = new AudioSender((b) => receiver.onWireBytes(b, 0), 'pcm16');
  sender.pushEncodedFrame(new Uint8Array(64));
  const stats = receiver.stats;
  assert.equal(stats.bufferedFrames, 1);
  assert.ok(stats.targetDelayMs >= AUDIO_FRAME_MS);
  assert.equal(stats.received, 1);
});
