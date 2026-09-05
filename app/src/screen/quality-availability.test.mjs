// Which quality presets a given host is allowed to offer.
//
//   cd app && node --test src/screen/quality-availability.test.mjs
//
// Hick's Law: the time to choose grows with the number of options, and an
// option that cannot work is the most expensive kind — it costs a decision AND
// the disappointment of making it wrong. Performance and Ultra need a hardware
// encoder. On a host without one they used to be offered anyway, with the
// caveat buried in prose the user had to read and then evaluate against a
// capability they have no way to see.
//
// The resolution picker already gets this right: it hides the virtual-display
// sizes entirely until the host advertises the driver. These tests hold quality
// to the same standard.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { availableQuality, DEFAULT_QUALITY, QUALITY, resolveQualityId } from './model.ts';

const ids = (presets) => presets.map((p) => p.id);

test('a host with a hardware encoder is offered everything', () => {
  assert.deepEqual(ids(availableQuality('gpu')), ids(QUALITY));
});

// The VMware dev VM is exactly this: a real video processor, but no hardware
// H.264 encoder, so the streamer reports path "cpu". Offering Ultra there
// promises 120fps the host provably cannot produce.
test('a host without a hardware encoder is not offered the presets that need one', () => {
  const cpu = ids(availableQuality('cpu'));
  assert.ok(!cpu.includes('performance'), 'Performance needs hardware encoding');
  assert.ok(!cpu.includes('ultra'), 'Ultra needs hardware encoding');
  assert.deepEqual(cpu, ['smooth', 'balanced', 'sharp']);
});

// Before the offer arrives there is no evidence of a hardware encoder, and
// assuming one is how a user picks Ultra and watches it not happen.
test('an unknown host is treated as having no hardware encoder', () => {
  assert.deepEqual(ids(availableQuality(null)), ['smooth', 'balanced', 'sharp']);
});

test('every host keeps at least one choice, and the default is always among them', () => {
  for (const path of ['gpu', 'cpu', null]) {
    const available = availableQuality(path);
    assert.ok(available.length > 0, `no presets offered for ${path}`);
    assert.ok(
      available.some((p) => p.id === DEFAULT_QUALITY),
      `the default preset must survive on ${path}`,
    );
  }
});

test('a supported selection is left alone', () => {
  assert.equal(resolveQualityId('balanced', availableQuality('cpu')), 'balanced');
  assert.equal(resolveQualityId('ultra', availableQuality('gpu')), 'ultra');
});

// The picker can be showing Ultra when the stream drops to the CPU path — a
// reconnect to a different host, or an encoder that stopped answering. Leaving
// it selected means the app displays one thing and does another.
test('a selection the host can no longer honour falls back to the closest that survives', () => {
  const cpu = availableQuality('cpu');
  assert.equal(resolveQualityId('ultra', cpu), 'sharp', 'falls to the best remaining, not to the default');
  assert.equal(resolveQualityId('performance', cpu), 'sharp');
});

test('resolving against an empty list still yields a usable id', () => {
  assert.equal(resolveQualityId('ultra', []), DEFAULT_QUALITY);
});

// The flag exists so the decision is data, not prose. A hint that gets reworded
// must never silently change which controls appear.
test('capability is a flag, not a phrase parsed out of the hint', () => {
  for (const preset of QUALITY) {
    if (preset.requiresHardwareEncode) continue;
    assert.ok(
      availableQuality('cpu').some((p) => p.id === preset.id),
      `${preset.id} is not flagged, so it must survive on a CPU-only host`,
    );
  }
});
