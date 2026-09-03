// Pure RTP packetization math for the video track: fragment counts, timestamp
// mapping, and the pacing schedule.
//
// This is the headless-testable REFERENCE for the numbers the native transport
// uses (belay_transport.cpp): the fragment budget here IS the
// BELAY_MAX_FRAGMENT_SIZE the packetizer is constructed with, and the 90 kHz
// timestamp mapping here IS the one applied per frame. Keeping the math pure
// and tested means the bandwidth/pacing model can be reasoned about (and the
// loss-lab can consume it) without any hardware.

/** RTP video clock (both H.264 and HEVC): 90 kHz. */
export const RTP_VIDEO_CLOCK_HZ = 90_000;

/** Conservative wire budget: WebRTC's usual 1200-byte MTU assumption keeps
 *  packets under every common path MTU (1500 ethernet, tunnels, cellular). */
export const DEFAULT_MTU_BYTES = 1200;
export const RTP_HEADER_BYTES = 12;

/** Payload available to media per packet — mirrors BELAY_MAX_FRAGMENT_SIZE in
 *  belay_transport.cpp (1200 - 12 = 1188). */
export const MAX_RTP_PAYLOAD_BYTES = DEFAULT_MTU_BYTES - RTP_HEADER_BYTES;

/** Fragmentation-unit overhead per fragment: H.264 FU-A = 2 bytes (FU
 *  indicator + FU header); HEVC FU = 3 bytes (2-byte NAL header + FU header). */
export const FU_OVERHEAD_BYTES = Object.freeze({ h264: 2, hevc: 3 });

export type PacketCodec = keyof typeof FU_OVERHEAD_BYTES;

/**
 * Maps a capture timestamp (ms, monotonic) to a 90 kHz RTP timestamp, anchored
 * at a base capture time and start timestamp — the same mapping
 * belay_transport_send_frame applies. Wraps at 2^32 like the wire field.
 */
export function ptsMsToRtpTimestamp(ptsMs: number, basePtsMs: number, startTimestamp = 0): number {
  if (!Number.isFinite(ptsMs) || !Number.isFinite(basePtsMs)) {
    throw new RangeError('pts must be finite');
  }
  if (ptsMs < basePtsMs) throw new RangeError('pts precedes the base pts');
  const ticks = Math.round(((ptsMs - basePtsMs) / 1000) * RTP_VIDEO_CLOCK_HZ);
  return (startTimestamp + ticks) >>> 0; // modulo 2^32, unsigned
}

/**
 * How many RTP packets one NAL unit costs. A NAL that fits the payload budget
 * rides as a single NAL unit packet; a bigger one is fragmented (FU-A / FU)
 * with per-fragment overhead. Zero-length NALs are malformed input.
 */
export function packetsForNal(
  nalBytes: number,
  codec: PacketCodec,
  maxPayload = MAX_RTP_PAYLOAD_BYTES,
): number {
  if (!Number.isInteger(nalBytes) || nalBytes <= 0) throw new RangeError('nalBytes must be a positive integer');
  if (!Number.isInteger(maxPayload) || maxPayload <= FU_OVERHEAD_BYTES[codec]) {
    throw new RangeError('maxPayload must exceed the fragmentation overhead');
  }
  if (nalBytes <= maxPayload) return 1;
  const perFragment = maxPayload - FU_OVERHEAD_BYTES[codec];
  return Math.ceil(nalBytes / perFragment);
}

/** Packet count and wire bytes for a whole access unit (a list of NAL sizes). */
export interface AccessUnitCost {
  readonly packets: number;
  /** Total bytes on the wire including RTP headers and FU overhead. */
  readonly wireBytes: number;
}

export function costOfAccessUnit(
  nalSizes: readonly number[],
  codec: PacketCodec,
  maxPayload = MAX_RTP_PAYLOAD_BYTES,
): AccessUnitCost {
  if (nalSizes.length === 0) throw new RangeError('access unit has no NAL units');
  let packets = 0;
  let mediaBytes = 0;
  let fuOverhead = 0;
  for (const size of nalSizes) {
    const n = packetsForNal(size, codec, maxPayload);
    packets += n;
    mediaBytes += size;
    if (n > 1) fuOverhead += n * FU_OVERHEAD_BYTES[codec];
  }
  return { packets, wireBytes: mediaBytes + fuOverhead + packets * RTP_HEADER_BYTES };
}

/**
 * Pacing schedule: send offsets (ms) spreading a frame's packets across a
 * fraction of the frame interval instead of bursting them. A burst fills the
 * bottleneck queue and shows up as RTT growth — the very signal the ABR's
 * RTT-gradient guard then reacts to; pacing keeps the queue shallow.
 *
 * The spread uses at most `spreadFraction` of the interval (default 50%) so the
 * last packet still leaves well before the next frame is due.
 */
export function paceSchedule(
  packetCount: number,
  frameIntervalMs: number,
  spreadFraction = 0.5,
): number[] {
  if (!Number.isInteger(packetCount) || packetCount <= 0) {
    throw new RangeError('packetCount must be a positive integer');
  }
  if (!(frameIntervalMs > 0) || !(spreadFraction > 0) || spreadFraction > 1) {
    throw new RangeError('invalid pacing parameters');
  }
  if (packetCount === 1) return [0];
  const window = frameIntervalMs * spreadFraction;
  const step = window / (packetCount - 1);
  return Array.from({ length: packetCount }, (_, i) => i * step);
}

/**
 * Sanity model tying the ABR setpoint to packet rate: at `bitrateBps` and
 * `fps`, the per-frame byte budget and the packets it implies. The loss-lab
 * uses this to translate a control-law setpoint into wire pressure.
 */
export interface FrameBudget {
  readonly bytesPerFrame: number;
  readonly packetsPerFrame: number;
}

export function frameBudget(bitrateBps: number, fps: number, maxPayload = MAX_RTP_PAYLOAD_BYTES): FrameBudget {
  if (!(bitrateBps > 0) || !(fps > 0)) throw new RangeError('bitrate and fps must be positive');
  const bytesPerFrame = Math.floor(bitrateBps / 8 / fps);
  return {
    bytesPerFrame,
    packetsPerFrame: Math.max(1, Math.ceil(bytesPerFrame / maxPayload)),
  };
}
