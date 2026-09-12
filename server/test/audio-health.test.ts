// Every audio failure the phone can be told about, and the fix each one names.
// The point of this file: "unavailable" must never be the answer again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_STALL_TIMEOUT_MS,
  audioStreamStalled,
  classifyAudioFailure,
  stalledCaptureFailure,
} from '../src/audio-health.js';

test('a helper built before the audio verbs is named as such, with the rebuild command', () => {
  const f = classifyAudioFailure('unknown command: audiostart', 'win32');
  assert.equal(f.kind, 'unsupported-helper');
  assert.match(f.hint, /build:native/);
  assert.equal(f.detail, 'unknown command: audiostart');
});

test('a dead helper is distinguished from a helper that lacks the feature', () => {
  const f = classifyAudioFailure('native helper is not ready', 'darwin');
  assert.equal(f.kind, 'helper-missing');
  assert.match(f.hint, /Restart Belay/);
});

test('a refused TCC grant names the exact macOS pane', () => {
  const f = classifyAudioFailure(
    'screen recording permission is required — grant Privacy & Security → Screen & System Audio Recording',
    'darwin',
  );
  assert.equal(f.kind, 'permission');
  assert.match(f.hint, /Screen & System Audio Recording/);
});

test('the same permission fault gives Windows advice on Windows', () => {
  const f = classifyAudioFailure('access is denied', 'win32');
  assert.equal(f.kind, 'permission');
  assert.match(f.hint, /On the PC/);
});

test('a host with no playback endpoint is told to plug one in', () => {
  const win = classifyAudioFailure('no default render endpoint (hr=0x88890008)', 'win32');
  assert.equal(win.kind, 'no-device');
  assert.match(win.hint, /playback device/);
  const mac = classifyAudioFailure('no shareable display to anchor the audio stream', 'darwin');
  assert.equal(mac.kind, 'no-device');
  assert.match(mac.hint, /display/);
});

test('an unrecognised failure keeps its own text rather than inventing one', () => {
  const f = classifyAudioFailure('the flux capacitor desynchronised', 'darwin');
  assert.equal(f.kind, 'unknown');
  assert.equal(f.message, 'the flux capacitor desynchronised');
  assert.equal(f.hint, '');
});

test('a missing or non-string reason never throws', () => {
  assert.equal(classifyAudioFailure(undefined).kind, 'unknown');
  assert.equal(classifyAudioFailure(null).kind, 'unknown');
  assert.equal(classifyAudioFailure({}).kind, 'unknown');
  assert.equal(classifyAudioFailure('   ').kind, 'unknown');
});

test('a stall with a recognisable stop reason reports the real fault, not the stall', () => {
  const f = stalledCaptureFailure('screen recording permission was revoked', 'darwin');
  assert.equal(f.kind, 'permission');
});

test('a stall with no stop reason says so honestly and suggests a retoggle', () => {
  const f = stalledCaptureFailure(undefined, 'win32');
  assert.equal(f.kind, 'capture-stalled');
  assert.match(f.message, /no sound is arriving/);
  assert.match(f.hint, /toggle host audio/);
});

test('a stall with an unrecognised stop reason carries that reason forward', () => {
  const f = stalledCaptureFailure('device was unplugged mid-stream', 'win32');
  assert.equal(f.kind, 'capture-stalled');
  assert.match(f.message, /device was unplugged mid-stream/);
});

test('the stall clock only fires after the timeout, and never on a bad clock', () => {
  assert.equal(audioStreamStalled(1000, 1000), false);
  assert.equal(audioStreamStalled(1000 + AUDIO_STALL_TIMEOUT_MS - 1, 1000), false);
  assert.equal(audioStreamStalled(1000 + AUDIO_STALL_TIMEOUT_MS, 1000), true);
  assert.equal(audioStreamStalled(Number.NaN, 1000), false);
  assert.equal(audioStreamStalled(1000, Number.NaN), false);
});
