import test from 'node:test';
import assert from 'node:assert/strict';

import { debugUiEnabled } from '../src/debug-ui.ts';
import { parseStreamerLine } from '../src/bwp-stream.ts';

// Off unless asked for. A debug console answering on a LAN tells a stranger
// this machine runs Belay and which features it has — a hint nobody outside
// the household has any business collecting.
test('the debug harness is off unless explicitly enabled', () => {
  assert.equal(debugUiEnabled({}), false);
  assert.equal(debugUiEnabled({ BELAY_DEBUG_UI: '' }), false);
  assert.equal(debugUiEnabled({ BELAY_DEBUG_UI: '0' }), false);
  assert.equal(debugUiEnabled({ BELAY_DEBUG_UI: 'off' }), false);
  assert.equal(debugUiEnabled({ BELAY_DEBUG_UI: 'maybe' }), false);
});

test('the usual affirmatives all turn it on', () => {
  for (const v of ['1', 'true', 'TRUE', 'on', 'yes', ' yes ']) {
    assert.equal(debugUiEnabled({ BELAY_DEBUG_UI: v }), true, `"${v}" should enable it`);
  }
});

// The mirrored frame line. Only shape is checked on this side — the browser is
// the thing that has to make sense of the bytes.
test('a mirrored H.264 frame line is parsed', () => {
  const e = parseStreamerLine('{"type":"h264","key":true,"b64":"AAAAAWdC"}');
  assert.deepEqual(e, { type: 'h264', key: true, b64: 'AAAAAWdC' });
});

test('a delta frame is not mistaken for a keyframe', () => {
  const e = parseStreamerLine('{"type":"h264","key":false,"b64":"AAAB"}');
  assert.equal(e?.type, 'h264');
  if (e?.type === 'h264') assert.equal(e.key, false);
});

// A missing or empty payload is not a frame. Forwarding one would have the
// browser feed an empty chunk to VideoDecoder, which fails the decoder
// permanently rather than skipping one picture.
test('an empty or malformed mirror line is refused', () => {
  assert.equal(parseStreamerLine('{"type":"h264","key":true}'), null);
  assert.equal(parseStreamerLine('{"type":"h264","key":true,"b64":""}'), null);
  assert.equal(parseStreamerLine('{"type":"h264","key":true,"b64":123}'), null);
});

// `key` is only true when it is literally true. A truthy string would make
// every frame look like a keyframe and the decoder would accept garbage as a
// starting point.
test('key is strict, not truthy', () => {
  const e = parseStreamerLine('{"type":"h264","key":"yes","b64":"AAAB"}');
  assert.equal(e?.type, 'h264');
  if (e?.type === 'h264') assert.equal(e.key, false);
});
