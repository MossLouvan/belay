import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_ADVANCE_DWELL_MS,
  GUIDE_CHECK_TIMEOUT_MS,
  GUIDE_POLL_MS,
  GUIDE_STEPS,
  guideProbeTarget,
  guideProgress,
  guideStepIndex,
  nextAutoAdvance,
  nextGuideStep,
  prevGuideStep,
  readGuideDetection,
} from './tailscale-flow.ts';

const lanUrl = 'http://192.168.0.81:8787';
const tsUrl = 'http://100.108.50.23:8787';
const lan = { kind: 'lan', url: lanUrl };
const ts = { kind: 'tailscale', url: tsUrl };

const host = (extra = {}) => ({ ok: true, addresses: [lan, ts], ...extra });

// ---- step order -----------------------------------------------------------

test('the climb runs intro → install → account → connect', () => {
  assert.deepEqual([...GUIDE_STEPS], ['intro', 'install', 'account', 'connect']);
});

test('nextGuideStep walks forward and stops at the top', () => {
  assert.equal(nextGuideStep('intro'), 'install');
  assert.equal(nextGuideStep('install'), 'account');
  assert.equal(nextGuideStep('account'), 'connect');
  assert.equal(nextGuideStep('connect'), null);
});

test('prevGuideStep walks back and stops at the bottom', () => {
  assert.equal(prevGuideStep('connect'), 'account');
  assert.equal(prevGuideStep('intro'), null);
});

test('guideStepIndex matches the declared order', () => {
  GUIDE_STEPS.forEach((step, i) => assert.equal(guideStepIndex(step), i));
});

test('progress runs 0 → 1 across the climb, monotonically', () => {
  assert.equal(guideProgress('intro'), 0);
  assert.equal(guideProgress('connect'), 1);
  const values = GUIDE_STEPS.map(guideProgress);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] > values[i - 1], `progress must climb at step ${GUIDE_STEPS[i]}`);
  }
});

// ---- poll cadence ---------------------------------------------------------

test('each check finishes before the next poll is due', () => {
  assert.ok(GUIDE_CHECK_TIMEOUT_MS < GUIDE_POLL_MS);
});

// ---- guideProbeTarget -----------------------------------------------------

test('a LAN check on a tailnet-capable host probes the tailnet address', () => {
  assert.equal(guideProbeTarget(host(), lanUrl), tsUrl);
});

test('a check that already proved the tailnet needs no probe', () => {
  assert.equal(guideProbeTarget(host({ pairing: 'tailnet' }), lanUrl), null);
});

test('a host with no tailnet address offers no probe target', () => {
  assert.equal(guideProbeTarget({ ok: true, addresses: [lan] }, lanUrl), null);
});

test('a failed check offers no probe target', () => {
  assert.equal(guideProbeTarget({ ok: false, error: 'timed out' }, lanUrl), null);
});

// ---- readGuideDetection ---------------------------------------------------

test('an unreachable host means keep waiting, not an error', () => {
  assert.deepEqual(
    readGuideDetection({ ok: false, error: 'timed out' }, lanUrl, null),
    { kind: 'waiting', detail: 'timed out' },
  );
});

test('a check that arrived over the tailnet is connected on the checked url', () => {
  assert.deepEqual(
    readGuideDetection(host({ pairing: 'tailnet' }), lanUrl, null),
    { kind: 'connected', url: lanUrl },
  );
});

test('a probe that pairs over the tailnet is connected on the tailnet url', () => {
  assert.deepEqual(
    readGuideDetection(host(), lanUrl, { ok: true, pairing: 'tailnet' }),
    { kind: 'connected', url: tsUrl },
  );
});

test('a probe that fails means keep waiting, with the failure attached', () => {
  assert.deepEqual(
    readGuideDetection(host(), lanUrl, { ok: false, error: 'refused' }),
    { kind: 'waiting', detail: 'refused' },
  );
});

test('a probe that answers but still wants digits falls back to the code', () => {
  assert.deepEqual(
    readGuideDetection(host(), lanUrl, { ok: true, pairing: 'code' }),
    { kind: 'code-required' },
  );
});

test('an upgrade plan with no probe yet means keep waiting', () => {
  assert.deepEqual(readGuideDetection(host(), lanUrl, null), { kind: 'waiting' });
});

test('a host with no tailnet address at all is called out as such', () => {
  assert.deepEqual(
    readGuideDetection({ ok: true, addresses: [lan] }, lanUrl, null),
    { kind: 'no-tailnet' },
  );
});

// ---- nextAutoAdvance ------------------------------------------------------

const idle = { kind: 'idle' };
const connected = (url) => ({ kind: 'connected', url });
const waiting = { kind: 'waiting', detail: 'timed out' };

test('one connected reading only starts the streak — never advances alone', () => {
  assert.deepEqual(nextAutoAdvance(idle, connected(tsUrl)), { kind: 'confirming', url: tsUrl });
});

test('two connected readings in a row arm the auto-advance', () => {
  const confirming = nextAutoAdvance(idle, connected(tsUrl));
  assert.deepEqual(nextAutoAdvance(confirming, connected(tsUrl)), { kind: 'ready', url: tsUrl });
});

test('a miss between the two readings resets the streak — one lucky packet never advances', () => {
  const confirming = nextAutoAdvance(idle, connected(tsUrl));
  assert.deepEqual(nextAutoAdvance(confirming, waiting), idle);
});

test('non-connected readings leave idle alone — same value, not a fresh copy', () => {
  // Identity matters: a screen holding this in state must not re-render on
  // every empty poll.
  assert.equal(nextAutoAdvance(idle, waiting), idle);
  assert.equal(nextAutoAdvance(idle, { kind: 'no-tailnet' }), idle);
  assert.equal(nextAutoAdvance(idle, { kind: 'code-required' }), idle);
});

test('ready never demotes, whatever a late poll says', () => {
  const ready = { kind: 'ready', url: tsUrl };
  assert.deepEqual(nextAutoAdvance(ready, waiting), ready);
  assert.deepEqual(nextAutoAdvance(ready, { kind: 'code-required' }), ready);
  assert.deepEqual(nextAutoAdvance(ready, connected(lanUrl)), ready);
});

test('the confirming read carries the freshest url forward', () => {
  // The follow-up poll may discover a better address; ready keeps that one.
  const confirming = nextAutoAdvance(idle, connected(lanUrl));
  assert.deepEqual(nextAutoAdvance(confirming, connected(tsUrl)), { kind: 'ready', url: tsUrl });
});

test('the connected dwell is a readable beat, well under one poll interval', () => {
  assert.ok(AUTO_ADVANCE_DWELL_MS >= 500);
  assert.ok(AUTO_ADVANCE_DWELL_MS < GUIDE_POLL_MS);
});

test('checking the tailnet address itself and being asked for a code is code-required', () => {
  // The checked url IS the advertised tailnet address, so there is nothing to
  // upgrade to — but the host answered without recognising the phone.
  assert.deepEqual(
    readGuideDetection(host({ pairing: 'code' }), tsUrl, null),
    { kind: 'code-required' },
  );
});
