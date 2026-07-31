// CPU load sampling. Load is the change in busy time between two readings, so
// it is inherently stateful — but the state lives inside a meter instance
// created by the caller rather than in a module-level mutable global, and the
// meter samples on its own cadence rather than on each read. The sampling and
// arithmetic themselves are pure and independently testable.

import { cpus } from 'node:os';

export interface CpuSample {
  readonly idle: number;
  readonly total: number;
}

/** Sum of idle and total jiffies across every core, right now. */
export function sampleCpu(): CpuSample {
  const list = cpus();
  const totals = list.reduce(
    (acc, core) => {
      const busyAndIdle = Object.values(core.times).reduce((sum, t) => sum + t, 0);
      return { idle: acc.idle + core.times.idle, total: acc.total + busyAndIdle };
    },
    { idle: 0, total: 0 },
  );
  return { idle: totals.idle, total: totals.total };
}

/**
 * Busy percentage between two samples, clamped to 0..100.
 * Returns 0 when the samples are identical or out of order (no elapsed time
 * means no meaningful load figure — reporting 0 is safer than dividing by zero).
 */
export function cpuPercentBetween(prev: CpuSample, next: CpuSample): number {
  const idleDiff = next.idle - prev.idle;
  const totalDiff = next.total - prev.total;
  if (totalDiff <= 0) return 0;
  const busyRatio = 1 - idleDiff / totalDiff;
  return Math.max(0, Math.min(100, Math.round(busyRatio * 100)));
}

export interface CpuMeter {
  /** The most recent computed load. Cheap, and safe to call concurrently. */
  read(): number;
  /** Take a sample now and recompute, ignoring the cadence. Mainly for tests. */
  refresh(): number;
  /** Stop the background sampler. Idempotent. */
  stop(): void;
}

export interface CpuMeterOptions {
  /** How often the load figure is recomputed. Default 1s. */
  readonly intervalMs?: number;
  /** Sample source; injectable so the meter can be tested deterministically. */
  readonly sample?: () => CpuSample;
  /** Clock source, same reason. */
  readonly now?: () => number;
  /** Set false to skip the background timer (tests drive `refresh` instead). */
  readonly autoStart?: boolean;
}

const DEFAULT_INTERVAL_MS = 1000;

/** The implicit sample at boot: every counter starts at zero. */
const BOOT_SAMPLE: CpuSample = { idle: 0, total: 0 };

/**
 * A CPU meter whose sampling cadence is decoupled from how often it is read.
 *
 * The load figure is a delta between two samples, so *consuming* the delta on
 * every read is wrong when reads can overlap: two near-simultaneous callers
 * would race, and the second would see a zero-width window and get a spurious
 * 0%. Instead the meter recomputes on a fixed cadence and every read returns
 * the latest computed value — concurrent readers simply see the same number.
 *
 * The background timer is unref'd, so it never keeps the process alive.
 *
 * The very first value is the average busy share since boot (the cumulative
 * counters compared against zero), which is a real, sensible figure and needs
 * no elapsed interval — so the first request after startup is never 0/NaN.
 */
export function createCpuMeter(options: CpuMeterOptions = {}): CpuMeter {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sample = options.sample ?? sampleCpu;
  const now = options.now ?? Date.now;

  let previous = sample();
  let value = cpuPercentBetween(BOOT_SAMPLE, previous);
  let sampledAt = now();

  const recompute = (): number => {
    const next = sample();
    // A zero-width window means the caller raced the timer; keep the last good
    // reading rather than publishing the divide-by-zero guard's 0.
    if (next.total > previous.total) {
      value = cpuPercentBetween(previous, next);
      previous = next;
    }
    sampledAt = now();
    return value;
  };

  const timer = options.autoStart === false ? null : setInterval(recompute, intervalMs);
  timer?.unref?.();

  return {
    read(): number {
      // Belt and braces: if the timer is disabled or has been starved (e.g. a
      // blocked event loop), refresh on demand — but only once per interval, so
      // a burst of concurrent reads still shares one sampling window.
      if (now() - sampledAt >= intervalMs) recompute();
      return value;
    },
    refresh: recompute,
    stop(): void {
      if (timer) clearInterval(timer);
    },
  };
}
