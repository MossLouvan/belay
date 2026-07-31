// Parsers for the macOS `sw_vers` and `pmset` probes, plus the CPU maths.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSwVers, parsePmsetBattery } from '../src/osinfo.js';
import { cpuPercentBetween, sampleCpu, createCpuMeter, CpuSample } from '../src/cpu.js';

/**
 * A scripted sample source plus a manual clock, so the meter can be driven
 * deterministically without waiting on real time or real CPU counters.
 */
function scripted(samples: readonly CpuSample[]) {
  let index = 0;
  let clock = 0;
  return {
    sample: (): CpuSample => samples[Math.min(index++, samples.length - 1)],
    now: (): number => clock,
    advance: (ms: number): void => {
      clock += ms;
    },
    taken: (): number => index,
  };
}

test('parseSwVers reads ProductName and ProductVersion', () => {
  const out = [
    'ProductName:\t\tmacOS',
    'ProductVersion:\t\t26.3.1',
    'ProductVersionExtra:\t(a)',
    'BuildVersion:\t\t25D771280a',
  ].join('\n');
  assert.deepEqual(parseSwVers(out), { name: 'macOS', version: '26.3.1' });
});

test('parseSwVers returns null when the expected keys are absent', () => {
  assert.equal(parseSwVers(''), null);
  assert.equal(parseSwVers('BuildVersion: 25D771280a'), null);
});

test('parsePmsetBattery reads a discharging laptop', () => {
  const out = [
    "Now drawing from 'Battery Power'",
    ' -InternalBattery-0 (id=22872163)\t78%; discharging; 6:55 remaining present: true',
  ].join('\n');
  assert.deepEqual(parsePmsetBattery(out), { percent: 78, charging: false, source: 'Battery Power' });
});

test('parsePmsetBattery reads a charging laptop', () => {
  const out = [
    "Now drawing from 'AC Power'",
    ' -InternalBattery-0 (id=1)\t42%; charging; 1:10 remaining present: true',
  ].join('\n');
  assert.deepEqual(parsePmsetBattery(out), { percent: 42, charging: true, source: 'AC Power' });
});

test('parsePmsetBattery treats a full battery on AC as not charging', () => {
  const out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true";
  const info = parsePmsetBattery(out);
  assert.ok(info);
  assert.equal(info.percent, 100);
  assert.equal(info.charging, false);
});

test('parsePmsetBattery returns null for a desktop with no battery', () => {
  assert.equal(parsePmsetBattery("Now drawing from 'AC Power'\n"), null);
  assert.equal(parsePmsetBattery(''), null);
});

test('cpuPercentBetween returns 0 when no time has elapsed', () => {
  const s = { idle: 100, total: 200 };
  assert.equal(cpuPercentBetween(s, s), 0);
  assert.equal(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 50, total: 100 }), 0);
});

test('cpuPercentBetween computes busy share and clamps to 0..100', () => {
  assert.equal(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 25, total: 100 }), 75);
  assert.equal(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 100, total: 100 }), 0);
  assert.equal(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 0, total: 100 }), 100);
});

test('sampleCpu reports non-negative monotonic totals', () => {
  const a = sampleCpu();
  assert.ok(a.total > 0);
  assert.ok(a.idle >= 0);
  assert.ok(a.total >= a.idle);
});

test('createCpuMeter yields an in-range percentage and keeps its own state', () => {
  const meter = createCpuMeter();
  try {
    const first = meter.read();
    const second = meter.read();
    for (const v of [first, second]) {
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, `bad percentage: ${v}`);
    }
  } finally {
    meter.stop();
  }
});

test('the very first read is a sensible non-zero figure, not NaN or undefined', () => {
  // One sample exists at construction, so the first value is the average busy
  // share since boot: 1 - 20/100 = 80%.
  const src = scripted([{ idle: 20, total: 100 }]);
  const meter = createCpuMeter({ sample: src.sample, now: src.now, autoStart: false });
  const first = meter.read();
  assert.equal(first, 80);
  assert.ok(Number.isInteger(first));
});

test('concurrent reads inside one sampling window all get the same real value', () => {
  const src = scripted([
    { idle: 20, total: 100 }, // construction baseline -> 80% since boot
    { idle: 120, total: 300 }, // one interval later: 100 idle of 200 -> 50%
  ]);
  const meter = createCpuMeter({
    intervalMs: 1000,
    sample: src.sample,
    now: src.now,
    autoStart: false,
  });

  src.advance(1000);
  const burst = [meter.read(), meter.read(), meter.read(), meter.read()];

  // The first read in the window recomputes; the rest re-serve it. None of them
  // may see the zero-width-delta 0 that a per-read meter would return.
  assert.deepEqual(burst, [50, 50, 50, 50]);
  assert.equal(src.taken(), 2, 'a burst of reads must share a single sample');
});

test('a zero-width sampling window re-serves the last good value, never 0', () => {
  const src = scripted([
    { idle: 20, total: 100 },
    { idle: 120, total: 300 }, // -> 50%
    { idle: 120, total: 300 }, // identical: no elapsed jiffies
  ]);
  const meter = createCpuMeter({ sample: src.sample, now: src.now, autoStart: false });
  meter.refresh();
  assert.equal(meter.refresh(), 50, 'an empty delta must not clobber the reading');
});

test('the background sampler does not keep the process alive', () => {
  // Deliberately never stopped: the timer is unref'd, so this suite still
  // exits. If someone drops the .unref() the whole run hangs here.
  const meter = createCpuMeter({ intervalMs: 50 });
  assert.ok(meter.read() >= 0);
});
