import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAddress,
  parseStreamerLine,
  validFps,
  validPort,
  validPreset,
} from '../src/bwp-stream.ts';

test('a client UDP port must be a real, unprivileged port', () => {
  assert.equal(validPort(41234), 41234);
  assert.equal(validPort('41234'), 41234);
  assert.equal(validPort(65535), 65535);
  assert.equal(validPort(1024), 1024);
});

// A client claiming port 22 or 445 is broken or aiming our packet stream at
// something on its own network. Refusing is not pedantry — it is declining to
// be an amplifier.
test('privileged and nonsense ports are refused, not clamped', () => {
  for (const bad of [22, 445, 0, -1, 1023, 65536, 1e9, NaN, 'abc', null, undefined, {}]) {
    assert.equal(validPort(bad), null, `port ${String(bad)} must be refused`);
  }
});

test('an unknown bitrate preset falls back to auto rather than failing', () => {
  assert.equal(validPreset('high'), 'high');
  assert.equal(validPreset('data-saver'), 'data-saver');
  assert.equal(validPreset('ludicrous'), 'auto');
  assert.equal(validPreset(42), 'auto');
  assert.equal(validPreset(undefined), 'auto');
});

// Same bug the JPEG path already guards: an unbounded fps is a spin loop.
// Clamped on both sides because neither end trusts the other to have done it.
test('fps is clamped rather than trusted', () => {
  assert.equal(validFps(60), 60);
  assert.equal(validFps(100000), 120);
  assert.equal(validFps(0), 1);
  assert.equal(validFps(-5), 1);
  assert.equal(validFps('abc'), 60);
});

test('a ready line is parsed into an offer', () => {
  const e = parseStreamerLine(
    '{"type":"ready","port":42100,"width":1920,"height":1080,"path":"gpu","bitrate":1500000}',
  );
  assert.equal(e?.type, 'ready');
  if (e?.type !== 'ready') return;
  assert.equal(e.offer.port, 42100);
  assert.equal(e.offer.width, 1920);
  assert.equal(e.offer.path, 'gpu');
  // The key is filled in by the session, not by the child — the child never
  // echoes it back, so it cannot leak through a log of the child's output.
  assert.equal(e.offer.key, '');
});

test('stats and bitrate lines are parsed', () => {
  const s = parseStreamerLine('{"type":"stats","fps":59.0,"kbps":1521,"bitrate":2776395}');
  assert.equal(s?.type, 'stats');
  if (s?.type === 'stats') {
    assert.equal(s.fps, 59);
    assert.equal(s.kbps, 1521);
  }
  const b = parseStreamerLine('{"type":"bitrate","bps":4405791}');
  assert.deepEqual(b, { type: 'bitrate', bps: 4405791 });
});

test('an error line carries its message', () => {
  const e = parseStreamerLine('{"type":"error","error":"cannot duplicate display 3"}');
  assert.deepEqual(e, { type: 'error', error: 'cannot duplicate display 3' });
});

// The child writes to a pipe; a Rust panic, a driver message or a partial write
// can all put something on stdout that is not one of our lines. None of them
// may crash the server.
test('noise on the child stdout is ignored, not thrown', () => {
  for (const junk of [
    '',
    '   ',
    'thread \'main\' panicked at src/stream.rs:1',
    '{ not json',
    '{"type":"ready"}', // ready with no port is unusable
    '{"type":"something-else"}',
    'null',
    '[]',
  ]) {
    assert.equal(parseStreamerLine(junk), null, `must ignore: ${junk}`);
  }
});

test('a ready line missing a port is rejected rather than defaulted to zero', () => {
  assert.equal(parseStreamerLine('{"type":"ready","width":1920}'), null);
  assert.equal(parseStreamerLine('{"type":"ready","port":"42100"}'), null);
});

// Node reports IPv4-mapped IPv6 whenever the listener is dual-stack, which is
// the normal case. Passed through unchanged it gives the streamer an address it
// cannot parse, and the failure points at the config parser instead of here.
test('an IPv4-mapped address is unwrapped', () => {
  assert.equal(normalizeAddress('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeAddress('::FFFF:10.0.0.1'), '10.0.0.1');
  assert.equal(normalizeAddress('192.168.1.5'), '192.168.1.5');
});

test('a bare IPv6 address is bracketed so a port can be appended', () => {
  assert.equal(normalizeAddress('fe80::1'), '[fe80::1]');
  assert.equal(normalizeAddress('::1'), '[::1]');
  // A zone index is stripped: Rust's address parser rejects it.
  assert.equal(normalizeAddress('fe80::1%eth0'), '[fe80::1]');
  assert.equal(normalizeAddress('[fe80::1]'), '[fe80::1]');
});

// A socket with no peer must not become the literal string "undefined", which
// would be spawned into a config and fail somewhere far from the cause.
test('a missing address is refused rather than stringified', () => {
  assert.equal(normalizeAddress(undefined), null);
  assert.equal(normalizeAddress(null), null);
  assert.equal(normalizeAddress(''), null);
});
