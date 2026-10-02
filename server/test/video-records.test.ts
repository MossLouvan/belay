// The helper's video pipe (fd 3) carries length-prefixed records, each one a
// ready-to-send binary screen frame plus a flags byte. This is the parser on
// the Node side of that pipe: it must survive any chunking the OS picks and
// never hand out a partial record.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VIDEO_RECORD_KEYFRAME, splitVideoRecords } from '../src/video-records.js';

const record = (flags: number, body: number[]): Buffer => {
  const out = Buffer.alloc(4 + 1 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out[4] = flags;
  Buffer.from(body).copy(out, 5);
  return out;
};

test('one complete record splits into its flags and frame bytes', () => {
  const { records, rest } = splitVideoRecords(record(VIDEO_RECORD_KEYFRAME, [1, 2, 3]));
  assert.equal(records.length, 1);
  assert.equal(records[0].keyframe, true);
  assert.deepEqual(Array.from(records[0].frame), [1, 2, 3]);
  assert.equal(rest.length, 0);
});

test('a non-keyframe record reads keyframe=false', () => {
  const { records } = splitVideoRecords(record(0, [9]));
  assert.equal(records[0].keyframe, false);
});

test('records arriving in one chunk all come out, in order', () => {
  const chunk = Buffer.concat([record(1, [1]), record(0, [2, 2]), record(0, [3, 3, 3])]);
  const { records, rest } = splitVideoRecords(chunk);
  assert.deepEqual(records.map((r) => r.frame.length), [1, 2, 3]);
  assert.equal(rest.length, 0);
});

test('a record cut mid-way is held back as rest until the remainder arrives', () => {
  const whole = record(1, [5, 6, 7, 8]);
  const first = splitVideoRecords(whole.subarray(0, 6));
  assert.equal(first.records.length, 0);
  assert.equal(first.rest.length, 6);
  const second = splitVideoRecords(Buffer.concat([first.rest, whole.subarray(6)]));
  assert.equal(second.records.length, 1);
  assert.deepEqual(Array.from(second.records[0].frame), [5, 6, 7, 8]);
  assert.equal(second.rest.length, 0);
});

test('a header split across chunks is also held back', () => {
  const whole = record(0, [1]);
  const first = splitVideoRecords(whole.subarray(0, 2));
  assert.equal(first.records.length, 0);
  assert.equal(first.rest.length, 2);
});

test('the frame is a copy, not a view onto the pipe buffer', () => {
  const wire = record(0, [42]);
  const { records } = splitVideoRecords(wire);
  wire[5] = 0;
  assert.equal(records[0].frame[0], 42);
});

test('an absurd length is rejected so a corrupt pipe cannot pin memory', () => {
  const bad = Buffer.alloc(5);
  bad.writeUInt32BE(0xffffffff, 0);
  assert.throws(() => splitVideoRecords(bad));
});
