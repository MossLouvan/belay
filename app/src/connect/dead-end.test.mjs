import test from 'node:test';
import assert from 'node:assert/strict';

import { REOPEN_PAIRING_HINT, checkedAtLabel, detectDeadEnd } from './dead-end.ts';

const lan = { kind: 'lan', url: 'http://192.168.1.30:8787' };
const ts = { kind: 'tailscale', url: 'http://100.64.10.40:8787' };

/** A modern, already-paired host that requires a code from this connection. */
const pairedHost = (extra = {}) => ({
  ok: true,
  paired: true,
  pairing: 'code',
  addresses: [lan, ts],
  ...extra,
});

const unavailable = { kind: 'unavailable' };
const upgrade = { kind: 'upgrade', url: ts.url };

// ---- detectDeadEnd: when the code entry is honest work --------------------

test('an unpaired host is never a dead end — its code is live', () => {
  assert.equal(detectDeadEnd({ ok: true, paired: false, pairing: 'code' }, unavailable, null, null), null);
});

test('an older host reporting neither field is not a dead end', () => {
  // Old hosts opened a pairing window unconditionally, so absence of the
  // fields means the code flow works — warning would be a false alarm.
  assert.equal(detectDeadEnd({ ok: true }, unavailable, null, null), null);
});

test('paired but talking over the tailnet is not a dead end', () => {
  // pairing === 'tailnet' means the host will pair with no code at all.
  assert.equal(detectDeadEnd(pairedHost({ pairing: 'tailnet' }), { kind: 'ready' }, null, ts.url), null);
});

test('a probe that found the codeless path is not a dead end', () => {
  const probe = { kind: 'paired-path', url: ts.url };
  assert.equal(detectDeadEnd(pairedHost(), upgrade, probe, ts.url), null);
});

// ---- detectDeadEnd: the trap, and which advice fits -----------------------

test('paired + code required + unreachable tailnet points at Tailscale', () => {
  const probe = { kind: 'tailscale-off', detail: 'Network request failed' };
  assert.deepEqual(detectDeadEnd(pairedHost(), upgrade, probe, ts.url), {
    standing: 'unreachable',
    detail: 'Network request failed',
  });
});

test('the raw tailnet failure survives so a stuck setup can be reported', () => {
  const probe = { kind: 'tailscale-off' };
  assert.deepEqual(detectDeadEnd(pairedHost(), upgrade, probe, ts.url), {
    standing: 'unreachable',
    detail: undefined,
  });
});

test('reached over the tailnet but still asked for a code: unrecognised', () => {
  // Tailscale is fine here; only the computer can fix this one, so the advice
  // must not send anyone to the Tailscale app.
  const probe = { kind: 'code-required' };
  assert.deepEqual(detectDeadEnd(pairedHost(), upgrade, probe, ts.url), { standing: 'unrecognised' });
});

test('checked the tailnet address directly and still asked: unrecognised', () => {
  // planTailnetUpgrade says "unavailable" when the checked address already was
  // the tailnet one — the advertised list is what tells this apart from a
  // host with no tailnet address at all.
  assert.deepEqual(detectDeadEnd(pairedHost(), unavailable, null, ts.url), { standing: 'unrecognised' });
});

test('a host with no tailnet address at all: the computer is the only route', () => {
  assert.deepEqual(
    detectDeadEnd(pairedHost({ addresses: [lan] }), unavailable, null, null),
    { standing: 'none' },
  );
});

test('a paired host with no address list behaves like a tailnet-less one', () => {
  assert.deepEqual(detectDeadEnd(pairedHost({ addresses: undefined }), unavailable, null, null), {
    standing: 'none',
  });
});

test('an upgrade plan that was never probed stays honest: untried', () => {
  assert.deepEqual(detectDeadEnd(pairedHost(), upgrade, null, ts.url), { standing: 'untried' });
});

// ---- the way forward on the computer (#150) --------------------------------

// Belay.app users have no terminal and no npx: the computer itself shows a
// code (Pair another phone), so that is where the notice points.
test('the reopen hint points at Belay on the computer, not at a command', () => {
  assert.equal(REOPEN_PAIRING_HINT, 'Open Belay on your computer to see a pairing code');
  assert.doesNotMatch(REOPEN_PAIRING_HINT, /npx|--reset-pairing|TEST_CODE|belay-state/);
});

// ---- checkedAtLabel -------------------------------------------------------

test('the proof-of-life stamp is zero-padded wall-clock time', () => {
  const d = new Date(2026, 7, 31, 9, 4, 7);
  assert.equal(checkedAtLabel(d.getTime()), '09:04:07');
});
