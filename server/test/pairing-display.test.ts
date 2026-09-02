// Regression tests for the pairing display shared by boot and the rotation loop.
//
// The bug this guards against: the QR was printed once at boot, and five
// minutes later the rotation loop minted a fresh code and printed only a text
// line. The QR scrolled above still encoded the dead boot code, so scanning it
// failed ("that code didn't work") while the live code sat right under it — and
// every stale scan spent one of the client's five failures toward a lockout.
//
// The structural fix: one emitter renders the QR and the code together, and
// both display paths call it. These tests pin that invariant — the QR and the
// digits under it always name the same code — so it cannot silently regress.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emitPairingCode, pairingQrLink, PairingHostInfo } from '../src/pairing-display.js';
import { parsePairLink } from '../src/pair-link.js';
import { HostAddress } from '../src/addresses.js';

const info: PairingHostInfo = {
  hostId: 'da771aad-caa5-4be3-bbbc-01ae4a36d02b',
  label: 'MacBook Air',
  platform: 'darwin',
  port: 8787,
};

const addresses: HostAddress[] = [{ kind: 'lan', url: 'http://192.168.1.5:8787' }];

/** Capture what would reach the terminal, plus the code each artifact names. */
function capture() {
  const qrLinks: string[] = [];
  const lines: string[] = [];
  const sinks = {
    qr: (link: string) => qrLinks.push(link),
    line: (text: string) => lines.push(text),
  };
  return { qrLinks, lines, sinks };
}

test('a boot code then a rotation both emit a QR — the second is not text-only', () => {
  const { qrLinks, sinks } = capture();

  // Boot: code A.
  emitPairingCode(info, '111111', 300, sinks, addresses);
  // Rotation five minutes later: code B. The pre-fix loop printed only a text
  // line here, so no second QR was ever emitted.
  emitPairingCode(info, '222222', 300, sinks, addresses);

  assert.equal(qrLinks.length, 2, 'each code must reprint the QR, not just a text line');
});

test('the last QR on screen encodes the freshly rotated code, not the dead one', () => {
  const { qrLinks, sinks } = capture();

  emitPairingCode(info, '111111', 300, sinks, addresses);
  emitPairingCode(info, '222222', 300, sinks, addresses);

  const parsed = parsePairLink(qrLinks[qrLinks.length - 1]);
  assert.ok(parsed, 'the emitted QR must be a valid pair link');
  assert.equal(parsed.code, '222222');
});

test('the QR and the manual code line always name the same code', () => {
  const { qrLinks, lines, sinks } = capture();

  emitPairingCode(info, '222222', 300, sinks, addresses);

  const parsed = parsePairLink(qrLinks[qrLinks.length - 1]);
  assert.ok(parsed);
  const manualLine = lines.find((l) => l.includes('type it in manually'));
  assert.ok(manualLine, 'a manual fallback line must be printed');
  assert.ok(manualLine.includes(parsed.code), 'the code line must match the QR code');
});

test('pairingQrLink round-trips the code it is given', () => {
  const link = pairingQrLink(info, '654321', addresses);
  assert.ok(link);
  const parsed = parsePairLink(link);
  assert.ok(parsed);
  assert.equal(parsed.code, '654321');
});

test('with no reachable address the QR is skipped but the code still prints', () => {
  const { qrLinks, lines, sinks } = capture();

  // A host with nothing to advertise: no QR to render, but the manual path —
  // the whole reason the digits are shown too — must still work.
  emitPairingCode(info, '333333', 120, sinks, []);

  assert.equal(qrLinks.length, 0);
  assert.ok(lines.some((l) => l.includes('333333')));
});
