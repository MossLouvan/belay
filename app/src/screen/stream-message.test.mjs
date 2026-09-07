import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStreamMessage } from './stream-message.ts';

test('a JSON frame from an old host is parsed with its geometry', () => {
  const msg = parseStreamMessage(
    JSON.stringify({ type: 'frame', data: 'AAAA', w: 1280, h: 720, sw: 2560, sh: 1440, bytes: 3 }),
  );
  assert.equal(msg?.type, 'frame');
  if (msg?.type !== 'frame') return;
  assert.equal(msg.frame.data, 'AAAA');
  assert.equal(msg.frame.w, 1280);
  assert.equal(msg.frame.sw, 2560);
  assert.equal(msg.frame.bytes, 3);
});

test('an error carries its text, or a default when the host sent none', () => {
  assert.deepEqual(parseStreamMessage(JSON.stringify({ type: 'error', error: 'boom' })), {
    type: 'error',
    error: 'boom',
  });
  const blank = parseStreamMessage(JSON.stringify({ type: 'error', error: '' }));
  assert.equal(blank?.type, 'error');
  if (blank?.type === 'error') assert.ok(blank.error.length > 0);
});

test('anything unrecognised is null, never a throw', () => {
  for (const junk of [null, undefined, 42, 'not json', '{"broken', '[]', '{"type":"frame"}', JSON.stringify({ type: 'bwpOffer' })]) {
    assert.equal(parseStreamMessage(junk), null, `must ignore ${String(junk)}`);
  }
});
