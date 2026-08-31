// Unit tests for the hold-to-talk state machine, the failure vocabulary and
// the two-permission branching.
//
//   cd app && node --test src/agent/mic.test.mjs
//
// Same shape as the other suites here: no framework, plain assertions. Only
// JSX-free modules are imported, since Node strips types but does not compile
// JSX.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_SPEECH_MESSAGE,
  RECOGNIZER_UNAVAILABLE_MESSAGE,
  VOICE_IDLE,
  permissionProblem,
  reduceVoice,
  voiceErrorMessage,
} from './mic-state.ts';

const run = (...actions) => actions.reduce(reduceVoice, VOICE_IDLE);

// --- the happy path: idle → starting → listening → interim → final → idle ----

test('a full utterance walks every phase and carries its transcript', () => {
  let s = run({ type: 'press' });
  assert.equal(s.phase, 'starting');

  s = reduceVoice(s, { type: 'started' });
  assert.equal(s.phase, 'listening');
  assert.equal(s.heard, false);

  s = reduceVoice(s, { type: 'result', transcript: 'fix the' });
  assert.equal(s.transcript, 'fix the');
  assert.equal(s.heard, true);

  s = reduceVoice(s, { type: 'release' });
  assert.equal(s.phase, 'stopping');

  // The final text usually lands after the finger has lifted.
  s = reduceVoice(s, { type: 'result', transcript: 'fix the tests.' });
  assert.equal(s.transcript, 'fix the tests.');

  s = reduceVoice(s, { type: 'ended' });
  assert.deepEqual(s, VOICE_IDLE);
});

test('interim results replace, never append', () => {
  const s = run(
    { type: 'press' }, { type: 'started' },
    { type: 'result', transcript: 'hello' },
    { type: 'result', transcript: 'hello world' },
  );
  assert.equal(s.transcript, 'hello world');
});

// --- races and mis-taps ------------------------------------------------------

test('a second press while anything is in flight is ignored', () => {
  const listening = run({ type: 'press' }, { type: 'started' });
  assert.equal(reduceVoice(listening, { type: 'press' }), listening);
  const stopping = reduceVoice(listening, { type: 'release' });
  assert.equal(reduceVoice(stopping, { type: 'press' }), stopping);
});

test('release before the recognizer started still reaches stopping', () => {
  const s = run({ type: 'press' }, { type: 'release' });
  assert.equal(s.phase, 'stopping');
});

test('cancel discards the utterance from any phase', () => {
  for (const setup of [
    [{ type: 'press' }],
    [{ type: 'press' }, { type: 'started' }],
    [{ type: 'press' }, { type: 'started' }, { type: 'result', transcript: 'hi' }, { type: 'release' }],
  ]) {
    assert.deepEqual(reduceVoice(run(...setup), { type: 'cancel' }), VOICE_IDLE);
  }
});

test('events that outlive an utterance do not disturb idle', () => {
  assert.equal(reduceVoice(VOICE_IDLE, { type: 'started' }), VOICE_IDLE);
  assert.equal(reduceVoice(VOICE_IDLE, { type: 'release' }), VOICE_IDLE);
  assert.equal(reduceVoice(VOICE_IDLE, { type: 'result', transcript: 'ghost' }), VOICE_IDLE);
  assert.deepEqual(reduceVoice(VOICE_IDLE, { type: 'ended' }), VOICE_IDLE);
});

// --- errors ------------------------------------------------------------------

test('an error resets the machine but remembers it already spoke', () => {
  const s = run({ type: 'press' }, { type: 'started' }, { type: 'error' });
  assert.equal(s.phase, 'idle');
  assert.equal(s.failed, true);
  // iOS follows the error with an `end`; that must land back on clean idle so
  // the next press starts with failed=false.
  assert.deepEqual(reduceVoice(s, { type: 'ended' }), VOICE_IDLE);
  assert.equal(reduceVoice(s, { type: 'press' }).failed, false);
});

test('a clean stop that heard nothing is detectable before the end event', () => {
  const s = run({ type: 'press' }, { type: 'started' }, { type: 'release' });
  // This is the exact state the end handler inspects to say "no speech".
  assert.equal(s.phase, 'stopping');
  assert.equal(s.heard, false);
  assert.equal(s.failed, false);
});

test('reduceVoice never mutates its input', () => {
  const before = run({ type: 'press' }, { type: 'started' });
  const frozen = Object.freeze({ ...before });
  reduceVoice(before, { type: 'result', transcript: 'x' });
  assert.deepEqual(before, frozen);
});

// --- failure vocabulary ------------------------------------------------------

test('every recognizer error names what happened and a way forward', () => {
  assert.match(voiceErrorMessage('not-allowed'), /Settings/);
  assert.equal(voiceErrorMessage('service-not-allowed'), RECOGNIZER_UNAVAILABLE_MESSAGE);
  assert.equal(voiceErrorMessage('no-speech'), NO_SPEECH_MESSAGE);
  assert.equal(voiceErrorMessage('speech-timeout'), NO_SPEECH_MESSAGE);
  assert.match(voiceErrorMessage('network'), /internet/);
  assert.match(voiceErrorMessage('audio-capture'), /microphone/);
  assert.match(voiceErrorMessage('busy'), /try again/);
  assert.match(voiceErrorMessage('language-not-supported'), /language/);
  assert.match(voiceErrorMessage('interrupted'), /interrupted/);
});

test('a deliberate abort is not news', () => {
  assert.equal(voiceErrorMessage('aborted'), null);
});

test('unknown codes fall back to the platform detail, then a generic line', () => {
  assert.equal(voiceErrorMessage('unknown', 'the OS said so'), 'the OS said so');
  assert.equal(voiceErrorMessage('unknown'), 'speech recognition failed');
  assert.equal(voiceErrorMessage('client', ''), 'speech recognition failed');
});

// --- permission branching ----------------------------------------------------

test('a denied microphone is named before speech recognition is even asked', () => {
  assert.match(permissionProblem({ granted: false, canAskAgain: false }, null), /microphone/i);
  assert.match(permissionProblem(null, null), /microphone/i);
});

test('a denied speech recognizer is named on its own', () => {
  const mic = { granted: true, canAskAgain: false };
  assert.match(permissionProblem(mic, { granted: false }), /speech recognition/i);
  assert.match(permissionProblem(mic, null), /speech recognition/i);
});

test('both granted means no problem', () => {
  assert.equal(permissionProblem({ granted: true }, { granted: true }), null);
});

test('every permission problem routes to Settings', () => {
  for (const [mic, speech] of [
    [{ granted: false }, null],
    [{ granted: true }, { granted: false }],
  ]) {
    assert.match(permissionProblem(mic, speech), /Settings/);
  }
});
