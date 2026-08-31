// Photos are the second thing the composer can hand to Claude, and the plan
// is all-or-nothing: a batch that silently shrank would send a different
// question than the one the user composed. These tests pin the caps, the
// arithmetic and the boundary parsing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHOTOS,
  base64Bytes,
  parseImagesSent,
  planUpload,
  sendingPhotosLabel,
  uploadFailureMessage,
} from './photos.ts';

test('base64Bytes reports the decoded size, padding and whitespace included', () => {
  assert.equal(base64Bytes(''), 0);
  assert.equal(base64Bytes(Buffer.from('abc').toString('base64')), 3);
  assert.equal(base64Bytes(Buffer.from('ab').toString('base64')), 2);
  assert.equal(base64Bytes(Buffer.from('a').toString('base64')), 1);
  assert.equal(base64Bytes('QUJ D\n RA=='), 4); // "ABCD" with interleaved whitespace
  assert.equal(base64Bytes(Buffer.alloc(1024).toString('base64')), 1024);
});

test('a clean pick becomes uploads in pick order', () => {
  const plan = planUpload([{ base64: 'QQ==' }, { base64: 'Qg==' }]);
  assert.equal(plan.problem, null);
  assert.deepEqual(plan.uploads, ['QQ==', 'Qg==']);
});

test('a cancelled or empty pick is not an error', () => {
  assert.deepEqual(planUpload([]), { uploads: [], problem: null });
});

test('assets that arrived without bytes are named, not silently dropped', () => {
  const plan = planUpload([{ base64: null }, {}]);
  assert.equal(plan.uploads.length, 0);
  assert.match(plan.problem ?? '', /could not be read/);
});

test('too many photos refuses the whole batch', () => {
  const five = Array.from({ length: PHOTOS.maxImages + 1 }, () => ({ base64: 'QQ==' }));
  const plan = planUpload(five);
  assert.equal(plan.uploads.length, 0);
  assert.match(plan.problem ?? '', /at most 4/);
});

test('one oversize photo refuses the whole batch and names the ceiling', () => {
  const big = Buffer.alloc(PHOTOS.maxImageBytes + 1).toString('base64');
  const plan = planUpload([{ base64: 'QQ==' }, { base64: big }]);
  assert.equal(plan.uploads.length, 0);
  assert.match(plan.problem ?? '', /too large.*12 MB/);
});

test('a photo exactly at the ceiling passes', () => {
  const atCap = Buffer.alloc(PHOTOS.maxImageBytes).toString('base64');
  assert.equal(planUpload([{ base64: atCap }]).problem, null);
});

test('the send reply parses defensively — garbage collapses to zero, never NaN', () => {
  assert.deepEqual(parseImagesSent(null), { files: 0, relDir: '' });
  assert.deepEqual(parseImagesSent('ok'), { files: 0, relDir: '' });
  assert.deepEqual(parseImagesSent({ files: NaN, relDir: 7 }), { files: 0, relDir: '' });
  assert.deepEqual(parseImagesSent({ files: 2.9, relDir: '.tether/images/img-x' }), {
    files: 2,
    relDir: '.tether/images/img-x',
  });
});

test('the failure line carries the observed detail', () => {
  assert.equal(uploadFailureMessage('host said no'), 'the photos could not be sent — host said no');
});

test('the busy label counts honestly', () => {
  assert.equal(sendingPhotosLabel(1), 'Sending the photo to Claude…');
  assert.equal(sendingPhotosLabel(3), 'Sending 3 photos to Claude…');
});
