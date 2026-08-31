// The recorder's frame policy is what stands between "record my screen" and
// an unbounded pile of images, so these tests lead with the caps: thinning
// always lands on the ceiling, always keeps the endpoints, and the disk
// lifecycle never deletes anything this module did not create.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORDING,
  RECORDING_DIR_PATTERN,
  buildPrompt,
  frameName,
  isNewFrame,
  recordingDirName,
  staleRecordings,
  thinFrames,
} from '../src/recording-frames.js';

// ---- duplicate detection ---------------------------------------------------

test('the first frame is always new', () => {
  assert.equal(isNewFrame(undefined, 'abc'), true);
});

test('a byte-identical frame is a repeat; any difference is new', () => {
  assert.equal(isNewFrame('abc', 'abc'), false);
  assert.equal(isNewFrame('abc', 'abd'), true);
});

// ---- thinning --------------------------------------------------------------

test('thinning returns the input untouched when under the cap', () => {
  const frames = [1, 2, 3];
  assert.equal(thinFrames(frames, 5), frames);
  assert.equal(thinFrames(frames, 3), frames);
});

test('thinning lands exactly on the cap and keeps first and last', () => {
  const frames = Array.from({ length: 600 }, (_, i) => i);
  const kept = thinFrames(frames, RECORDING.maxKept);
  assert.equal(kept.length, RECORDING.maxKept);
  assert.equal(kept[0], 0);
  assert.equal(kept[kept.length - 1], 599);
});

test('thinned frames stay in chronological order with no repeats', () => {
  const frames = Array.from({ length: 137 }, (_, i) => i);
  const kept = thinFrames(frames, 24);
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i] > kept[i - 1]);
});

test('thinning edge caps: zero keeps nothing, one keeps the first frame', () => {
  assert.deepEqual([...thinFrames([1, 2, 3], 0)], []);
  assert.deepEqual([...thinFrames([1, 2, 3], 1)], [1]);
});

// ---- naming ----------------------------------------------------------------

test('frame names zero-pad so alphabetical order is chronological order', () => {
  assert.equal(frameName(0, 24), 'frame-01.jpg');
  assert.equal(frameName(23, 24), 'frame-24.jpg');
  assert.equal(frameName(99, 100), 'frame-100.jpg');
  assert.equal(frameName(0, 100), 'frame-001.jpg');
});

test('recording dir names match their own lifecycle pattern and sort by time', () => {
  const earlier = recordingDirName(new Date(2026, 7, 31, 9, 5, 1).getTime());
  const later = recordingDirName(new Date(2026, 7, 31, 14, 20, 51).getTime());
  assert.match(earlier, RECORDING_DIR_PATTERN);
  assert.match(later, RECORDING_DIR_PATTERN);
  assert.ok(earlier < later);
});

// ---- disk lifecycle --------------------------------------------------------

test('staleRecordings keeps the newest maxSaved and returns the rest', () => {
  const names = [
    'rec-20260830-090000',
    'rec-20260831-090000',
    'rec-20260829-090000',
    'rec-20260831-100000',
    'rec-20260828-090000',
    'rec-20260827-090000',
  ];
  const stale = staleRecordings(names, 5);
  assert.deepEqual([...stale], ['rec-20260827-090000']);
});

test('staleRecordings never touches names it did not mint', () => {
  const names = ['notes.md', '.DS_Store', 'rec-junk', 'rec-20260831-100000'];
  assert.deepEqual([...staleRecordings(names, 0)], ['rec-20260831-100000']);
});

test('staleRecordings is empty under the cap', () => {
  assert.deepEqual([...staleRecordings(['rec-20260831-100000'], 5)], []);
});

// ---- prompt ----------------------------------------------------------------

test('the prompt references the real relative path and the frame span', () => {
  const prompt = buildPrompt({
    relDir: '.tether/recordings/rec-20260831-142051',
    frameNames: ['frame-01.jpg', 'frame-02.jpg', 'frame-03.jpg'],
    seconds: 38,
  });
  assert.match(prompt, /\.tether\/recordings\/rec-20260831-142051\//);
  assert.match(prompt, /3 JPEG frames captured over 38s/);
  assert.match(prompt, /frame-01\.jpg through frame-03\.jpg/);
  assert.match(prompt, /describe what happens/);
  assert.match(prompt, /do not commit/);
});

test('a user note becomes the task; the default ask is dropped', () => {
  const prompt = buildPrompt({
    relDir: '.tether/recordings/rec-20260831-142051',
    frameNames: ['frame-01.jpg'],
    seconds: 4,
    note: '  the modal flickers when I click save  ',
  });
  assert.match(prompt, /the modal flickers when I click save/);
  assert.doesNotMatch(prompt, /describe what happens/);
  assert.match(prompt, /1 JPEG frame captured/);
});
