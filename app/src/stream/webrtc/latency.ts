// Glass-to-glass latency measurement for the WebRTC streaming path.
//
// "Glass to glass" is the only number that matters for a Parsec-class product:
// the wall-clock gap between a frame leaving the host's framebuffer and the same
// frame lighting up on the phone. Everything in the streaming rewrite is
// justified by moving this number, so it is measured from the first build rather
// than bolted on later.
//
// This module is pure arithmetic over timestamps the capture and render layers
// stamp onto frames. It holds no sockets and no clock of its own — the caller
// passes the clock in — so the whole thing is exercised under Node's test runner
// with a fake clock, and the same code runs unchanged on the device.

/** One frame's journey, in the host and client clocks that stamped it. */
export interface FrameTiming {
  /** Monotonic ms when the host captured the frame (host clock). */
  readonly captureHostMs: number;
  /** Monotonic ms when the client presented the frame (client clock). */
  readonly presentClientMs: number;
  /** Frame sequence number, for drop/reorder accounting. */
  readonly seq: number;
}

/**
 * The two device clocks are unrelated, so a raw subtraction is meaningless. The
 * caller supplies a `clockOffsetMs` — the estimated `clientClock - hostClock`
 * skew from the handshake ping (see estimateClockOffset) — which we subtract to
 * bring both stamps into one frame of reference.
 */
export function glassToGlassMs(frame: FrameTiming, clockOffsetMs: number): number {
  return frame.presentClientMs - clockOffsetMs - frame.captureHostMs;
}

/**
 * Clock-offset estimate from a round trip, NTP-style. `t0` client-sends,
 * `t1` host-receives, `t2` host-replies, `t3` client-receives. The offset is
 * ((t1 - t0) + (t2 - t3)) / 2, which cancels a symmetric network delay. Returns
 * the offset and the RTT so the caller can weight noisy samples by RTT.
 */
export function estimateClockOffset(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
): { offsetMs: number; rttMs: number } {
  const rttMs = t3 - t0 - (t2 - t1);
  // (client - host), the SAME convention glassToGlassMs subtracts, so the output
  // of this feeds straight in. The NTP identity for (server - client) is
  // ((t1-t0)+(t2-t3))/2; negating it gives (client - server) = (client - host).
  const offsetMs = (t0 - t1 + (t3 - t2)) / 2;
  return { offsetMs, rttMs };
}

/**
 * A bounded rolling window of the latest glass-to-glass samples. Percentiles,
 * not a mean: a stream that is smooth at p50 but spikes at p95 feels broken, and
 * the mean hides exactly that. Bounded so a long session cannot grow without
 * limit — an old sample tells you nothing about the link right now.
 */
export class LatencyWindow {
  private readonly samples: number[] = [];
  private readonly capacity: number;
  private drops = 0;
  private lastSeq = -1;

  constructor(capacity: number = 240) {
    if (capacity <= 0) throw new RangeError('LatencyWindow capacity must be positive');
    this.capacity = capacity;
  }

  /** Records one frame's glass-to-glass ms and updates drop accounting. */
  add(frame: FrameTiming, clockOffsetMs: number): void {
    // Never trust the producer: a NaN/negative/non-integer seq or a non-finite
    // timing would silently corrupt drop accounting and the percentile window.
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) return;
    if (!Number.isFinite(frame.captureHostMs) || !Number.isFinite(frame.presentClientMs)) return;
    if (this.lastSeq >= 0 && frame.seq > this.lastSeq + 1) {
      this.drops += frame.seq - this.lastSeq - 1;
    }
    // A late frame (seq below the high-water mark) is counted but never
    // un-drops an earlier gap — the gap was still visible to the viewer.
    this.lastSeq = Math.max(this.lastSeq, frame.seq);

    const value = glassToGlassMs(frame, clockOffsetMs);
    this.samples.push(value);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  get count(): number {
    return this.samples.length;
  }

  get dropped(): number {
    return this.drops;
  }

  /** `p` in 0..1. Nearest-rank on a copy, so the window stays insertion-ordered. */
  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    const clamped = Math.min(Math.max(p, 0), 1);
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = Math.ceil(clamped * sorted.length);
    const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
    return sorted[index]!;
  }

  snapshot(): LatencySnapshot {
    return {
      count: this.count,
      dropped: this.drops,
      p50: this.percentile(0.5),
      p95: this.percentile(0.95),
      p99: this.percentile(0.99),
    };
  }
}

export interface LatencySnapshot {
  readonly count: number;
  readonly dropped: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}
