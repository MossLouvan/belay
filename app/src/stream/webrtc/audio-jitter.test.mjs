// The jitter-buffer policy under scripted arrival patterns — reorder, loss,
// duplicates, bursts, underruns, stream restarts — with no timers and no audio.
//
//   cd app && node --test src/stream/webrtc/audio-jitter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUDIO_FRAME_MS } from './audio-frames.ts';
import {
  DEFAULT_JITTER_CONFIG,
  bufferedDepth,
  createJitterState,
  insertFrame,
  popFrame,
  targetDelayMs,
} from './audio-jitter.ts';

const frame = (seq, timestamp = seq * 960) => ({
  seq, timestamp, codec: 'opus', payload: new Uint8Array([seq & 0xff]),
});

/** Insert frames at a steady 20 ms cadence starting at t0. */
function insertAll(state, seqs, t0 = 0) {
  let s = state;
  let t = t0;
  for (const seq of seqs) {
    s = insertFrame(s, frame(seq), t).state;
    t += AUDIO_FRAME_MS;
  }
  return s;
}

test('waits for the prebuffer, then plays in order', () => {
  let s = createJitterState();
  assert.equal(popFrame(s).action.kind, 'wait', 'empty buffer: nothing to play');

  s = insertAll(s, [10]);
  assert.equal(popFrame(s).action.kind, 'wait', 'below target depth: still prebuffering');

  s = insertAll(s, [11, 12]);
  const first = popFrame(s);
  assert.equal(first.action.kind, 'play');
  assert.equal(first.action.frame.seq, 10);
  const second = popFrame(first.state);
  assert.equal(second.action.kind, 'play');
  assert.equal(second.action.frame.seq, 11);
});

test('reordered arrival plays back in seq order', () => {
  let s = createJitterState();
  s = insertAll(s, [5, 7, 6, 8]); // 6 and 7 swapped in flight
  const order = [];
  for (let i = 0; i < 4; i++) {
    const { state, action } = popFrame(s);
    s = state;
    if (action.kind === 'play') order.push(action.frame.seq);
  }
  assert.deepEqual(order, [5, 6, 7, 8]);
});

test('a lost frame is concealed once, then playback continues', () => {
  let s = createJitterState();
  s = insertAll(s, [1, 2, 3]); // prime and start
  s = popFrame(s).state; // plays 1, cursor -> 2
  s = popFrame(s).state; // plays 2, cursor -> 3
  s = popFrame(s).state; // plays 3, cursor -> 4
  s = insertAll(s, [5, 6], 200); // 4 was lost
  const gap = popFrame(s);
  assert.equal(gap.action.kind, 'conceal', 'missing 4 is concealed');
  const after = popFrame(gap.state);
  assert.equal(after.action.kind, 'play');
  assert.equal(after.action.frame.seq, 5);
  assert.equal(after.state.stats.concealed, 1);
});

test('a late frame (slot already passed) is counted and not replayed', () => {
  let s = createJitterState();
  s = insertAll(s, [1, 2, 3]);
  s = popFrame(s).state; // plays 1
  s = popFrame(s).state; // plays 2
  const { state, verdict } = insertFrame(s, frame(1), 500);
  assert.equal(verdict, 'late');
  assert.equal(state.stats.late, 1);
  assert.equal(bufferedDepth(state), bufferedDepth(s), 'late frame is not buffered');
});

test('duplicates are dropped', () => {
  let s = createJitterState();
  s = insertAll(s, [1, 2]);
  const { state, verdict } = insertFrame(s, frame(2), 100);
  assert.equal(verdict, 'duplicate');
  assert.equal(state.stats.duplicates, 1);
  assert.equal(bufferedDepth(state), 2);
});

test('an underrun rebuilds the prebuffer and grows the cushion', () => {
  let s = createJitterState();
  s = insertAll(s, [1, 2]);
  const before = s.targetDepthFrames;
  s = popFrame(s).state; // plays 1
  s = popFrame(s).state; // plays 2
  const dry = popFrame(s); // buffer empty mid-stream
  assert.equal(dry.action.kind, 'wait');
  assert.equal(dry.state.stats.underruns, 1);
  assert.equal(dry.state.targetDepthFrames, before + 1, 'underrun demands a deeper cushion');
  assert.equal(dry.state.nextPlaySeq, null, 'playout restarts through the prebuffer');
});

test('concealment is bounded: a long gap fast-forwards to real audio', () => {
  const config = { ...DEFAULT_JITTER_CONFIG, maxConsecutiveConceal: 2 };
  let s = createJitterState(config);
  s = insertAll(s, [1, 2]);
  s = popFrame(s).state; // plays 1
  s = popFrame(s).state; // plays 2, cursor -> 3
  s = insertAll(s, [20, 21, 22], 200); // 3..19 all lost
  let concealed = 0;
  let r = popFrame(s);
  while (r.action.kind === 'conceal') { concealed += 1; r = popFrame(r.state); }
  assert.equal(concealed, 2, 'conceals only up to the bound');
  assert.equal(r.action.kind, 'play');
  assert.equal(r.action.frame.seq, 20, 'then jumps to the newest real audio');
});

test('a huge seq jump is a stream restart: resync, not 5 seconds of concealment', () => {
  let s = createJitterState();
  s = insertAll(s, [1, 2, 3]);
  s = popFrame(s).state; // playout underway
  const { state, verdict } = insertFrame(s, frame(30_000), 1000);
  assert.equal(verdict, 'reset');
  assert.equal(state.stats.resets, 1);
  assert.equal(bufferedDepth(state), 1, 'buffer holds only the new stream');
  assert.equal(state.nextPlaySeq, null, 'prebuffers the new stream before playing');
});

test('seq wraparound at 65535 -> 0 plays continuously', () => {
  let s = createJitterState();
  s = insertAll(s, [65534, 65535, 0, 1]);
  const order = [];
  for (let i = 0; i < 4; i++) {
    const { state, action } = popFrame(s);
    s = state;
    if (action.kind === 'play') order.push(action.frame.seq);
  }
  assert.deepEqual(order, [65534, 65535, 0, 1]);
  assert.equal(s.stats.concealed, 0, 'the wrap is not mistaken for loss');
});

test('buffer growth is bounded: overflow sheds the oldest frames', () => {
  const config = { ...DEFAULT_JITTER_CONFIG, maxBufferFrames: 5, resetGapFrames: 1000 };
  let s = createJitterState(config);
  s = insertAll(s, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(bufferedDepth(s), 5);
  assert.equal(s.stats.overflowDropped, 2);
  assert.equal(s.frames[0].seq, 3, 'oldest were shed, newest kept');
});

test('jittery arrivals raise the adaptive target; calm arrivals lower it slowly', () => {
  let s = createJitterState();
  // Erratic arrival times: alternating 0 ms and 120 ms interarrival gaps.
  let t = 0;
  for (let seq = 0; seq < 30; seq++) {
    t += seq % 2 === 0 ? 0 : 120;
    s = insertFrame(s, frame(seq), t).state;
  }
  const jitteryTarget = s.targetDepthFrames;
  assert.ok(jitteryTarget > DEFAULT_JITTER_CONFIG.minDepthFrames,
    `jitter must deepen the buffer (got ${jitteryTarget})`);
  assert.ok(jitteryTarget <= DEFAULT_JITTER_CONFIG.maxDepthFrames, 'but never past the ceiling');
  assert.equal(targetDelayMs(s), jitteryTarget * AUDIO_FRAME_MS);

  // Long calm stretch: perfectly paced arrivals. Target decays toward the floor.
  for (let seq = 30; seq < 130; seq++) {
    t += AUDIO_FRAME_MS;
    s = insertFrame(s, frame(seq), t).state;
  }
  assert.ok(s.targetDepthFrames < jitteryTarget, 'calm shrinks the cushion');
});

test('states are never mutated: every operation returns a fresh value', () => {
  const s0 = createJitterState();
  const s1 = insertFrame(s0, frame(1), 0).state;
  assert.equal(bufferedDepth(s0), 0, 'original untouched by insert');
  const s2 = insertFrame(s1, frame(2), 20).state;
  const popped = popFrame(s2);
  assert.equal(bufferedDepth(s2), 2, 'original untouched by pop');
  assert.notEqual(popped.state, s2);
  Object.freeze(s2.stats); // frozen originals never throw later — nothing writes them
});
