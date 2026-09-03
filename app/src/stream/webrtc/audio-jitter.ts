// The jitter-buffer policy: pure logic deciding, for every arriving frame and
// every playout tick, what a receiver should do. No timers, no audio APIs, no
// mutation — every operation returns a new state — so the whole policy runs
// under `node --test` with scripted arrival patterns (reorder, loss, bursts,
// duplicates, stream restarts) long before a speaker exists.
//
// The shape is NetEq-in-miniature: an ordered buffer of undecoded frames, a
// playout cursor (`nextPlaySeq`), and an adaptive target depth derived from an
// RFC 3550-style interarrival-jitter estimate. The receiver calls `insertFrame`
// on arrival and `popFrame` every AUDIO_FRAME_MS tick; pop answers with exactly
// one of play / conceal / wait, so the driving loop has no policy of its own.

import {
  AUDIO_FRAME_MS,
  seqDelta,
  seqNewer,
  nextSeq,
  type AudioFrame,
} from './audio-frames.ts';

export interface JitterConfig {
  /** Frames buffered before playout starts, and the floor the adaptive target
   *  never goes below. 2 frames = 40 ms — audible only as initial delay. */
  readonly minDepthFrames: number;
  /** Ceiling on the adaptive target: latency past this is worse than loss. */
  readonly maxDepthFrames: number;
  /** Hard cap on buffered frames; beyond it the oldest is dropped (a stalled
   *  player must not grow memory without bound). */
  readonly maxBufferFrames: number;
  /** A gap larger than this is a new stream (host restarted capture), not
   *  loss: resync instead of concealing thousands of frames. */
  readonly resetGapFrames: number;
  /** Most consecutive frames concealed before fast-forwarding to real data. */
  readonly maxConsecutiveConceal: number;
}

export const DEFAULT_JITTER_CONFIG: JitterConfig = Object.freeze({
  minDepthFrames: 2,
  maxDepthFrames: 15, // 300 ms — beyond this, drop and resync
  maxBufferFrames: 50,
  resetGapFrames: 250, // 5 s of frames
  maxConsecutiveConceal: 5,
});

export interface JitterStats {
  readonly received: number;
  readonly duplicates: number;
  readonly late: number; // arrived after their playout slot had passed
  readonly overflowDropped: number;
  readonly played: number;
  readonly concealed: number;
  readonly underruns: number; // pop ticks with an empty buffer mid-stream
  readonly resets: number;
}

export interface JitterState {
  readonly config: JitterConfig;
  /** Buffered frames, ascending wrap-aware seq order, no duplicates. */
  readonly frames: readonly AudioFrame[];
  /** The seq the next pop wants to play, or null before playout has begun. */
  readonly nextPlaySeq: number | null;
  /** Adaptive prebuffer depth, in frames. */
  readonly targetDepthFrames: number;
  /** Interarrival jitter EWMA in ms (RFC 3550 shape). */
  readonly jitterMs: number;
  /** Arrival bookkeeping for the jitter estimate. */
  readonly lastArrival: { readonly seq: number; readonly atMs: number } | null;
  readonly consecutiveConcealed: number;
  readonly stats: JitterStats;
}

export type InsertVerdict = 'buffered' | 'duplicate' | 'late' | 'reset';

export type PopAction =
  | { readonly kind: 'play'; readonly frame: AudioFrame }
  | { readonly kind: 'conceal' } // fill one frame of silence/PLC; a real frame may still arrive
  | { readonly kind: 'wait' }; // prebuffering or stream over; emit nothing

const EMPTY_STATS: JitterStats = Object.freeze({
  received: 0, duplicates: 0, late: 0, overflowDropped: 0,
  played: 0, concealed: 0, underruns: 0, resets: 0,
});

export function createJitterState(config: JitterConfig = DEFAULT_JITTER_CONFIG): JitterState {
  return {
    config,
    frames: [],
    nextPlaySeq: null,
    targetDepthFrames: config.minDepthFrames,
    jitterMs: 0,
    lastArrival: null,
    consecutiveConcealed: 0,
    stats: EMPTY_STATS,
  };
}

export function bufferedDepth(state: JitterState): number {
  return state.frames.length;
}

/** One frame arrived. Returns the new state and what happened to the frame. */
export function insertFrame(
  state: JitterState,
  frame: AudioFrame,
  nowMs: number,
): { state: JitterState; verdict: InsertVerdict } {
  const stats = { ...state.stats, received: state.stats.received + 1 };

  // A wildly discontinuous seq means the sender restarted: resync to it.
  const reference = state.nextPlaySeq ?? state.lastArrival?.seq ?? null;
  if (reference !== null && Math.abs(seqDelta(reference, frame.seq)) > state.config.resetGapFrames) {
    return {
      state: {
        ...createJitterState(state.config),
        frames: [frame],
        lastArrival: { seq: frame.seq, atMs: nowMs },
        stats: { ...stats, resets: stats.resets + 1 },
      },
      verdict: 'reset',
    };
  }

  const withJitter = observeArrival(state, frame.seq, nowMs);

  // Too late: its playout slot already passed (or was concealed over).
  if (state.nextPlaySeq !== null && !seqNewer(frame.seq, state.nextPlaySeq) && frame.seq !== state.nextPlaySeq) {
    return {
      state: { ...withJitter, stats: { ...stats, late: stats.late + 1 } },
      verdict: 'late',
    };
  }

  if (state.frames.some((f) => f.seq === frame.seq)) {
    return {
      state: { ...withJitter, stats: { ...stats, duplicates: stats.duplicates + 1 } },
      verdict: 'duplicate',
    };
  }

  const inserted = insertSorted(state.frames, frame);
  // Overflow: shed from the OLD end — the newest audio is the valuable audio.
  const overflow = inserted.length > state.config.maxBufferFrames;
  const frames = overflow ? inserted.slice(inserted.length - state.config.maxBufferFrames) : inserted;

  return {
    state: {
      ...withJitter,
      frames,
      // Overflow may have shed the frame the cursor was waiting on; resync.
      nextPlaySeq: overflow && state.nextPlaySeq !== null && frames.length > 0 && seqNewer(frames[0].seq, state.nextPlaySeq)
        ? frames[0].seq
        : withJitter.nextPlaySeq,
      stats: overflow ? { ...stats, overflowDropped: stats.overflowDropped + (inserted.length - frames.length) } : stats,
    },
    verdict: 'buffered',
  };
}

/**
 * One playout tick (every AUDIO_FRAME_MS). Exactly one action:
 *  - play: hand this frame to the decoder;
 *  - conceal: the expected frame is missing — fill 20 ms (silence or PLC);
 *  - wait: still prebuffering (or nothing has ever arrived) — emit nothing.
 */
export function popFrame(state: JitterState): { state: JitterState; action: PopAction } {
  const { config } = state;

  // Before playout begins: wait until the prebuffer target is met.
  if (state.nextPlaySeq === null) {
    if (state.frames.length < state.targetDepthFrames) {
      return { state, action: { kind: 'wait' } };
    }
    const head = state.frames[0];
    return {
      state: {
        ...state,
        frames: state.frames.slice(1),
        nextPlaySeq: nextSeq(head.seq),
        consecutiveConcealed: 0,
        stats: { ...state.stats, played: state.stats.played + 1 },
      },
      action: { kind: 'play', frame: head },
    };
  }

  const head = state.frames[0];

  // Empty buffer mid-stream: an underrun. Rebuild the prebuffer before playing
  // again, and grow the target — repeated underruns mean the network needs more
  // cushion than the estimate thought.
  if (!head) {
    return {
      state: {
        ...state,
        nextPlaySeq: null,
        targetDepthFrames: Math.min(state.targetDepthFrames + 1, config.maxDepthFrames),
        consecutiveConcealed: 0,
        stats: { ...state.stats, underruns: state.stats.underruns + 1 },
      },
      action: { kind: 'wait' },
    };
  }

  // The expected frame is here: play it.
  if (head.seq === state.nextPlaySeq) {
    return {
      state: {
        ...state,
        frames: state.frames.slice(1),
        nextPlaySeq: nextSeq(head.seq),
        consecutiveConcealed: 0,
        stats: { ...state.stats, played: state.stats.played + 1 },
      },
      action: { kind: 'play', frame: head },
    };
  }

  // Gap: the expected frame is missing but newer ones are buffered. Conceal one
  // tick — it may yet arrive — unless we have concealed too long already, in
  // which case jump to the real data (latency over an ever-longer silence).
  if (state.consecutiveConcealed >= config.maxConsecutiveConceal) {
    return {
      state: {
        ...state,
        frames: state.frames.slice(1),
        nextPlaySeq: nextSeq(head.seq),
        consecutiveConcealed: 0,
        stats: { ...state.stats, played: state.stats.played + 1 },
      },
      action: { kind: 'play', frame: head },
    };
  }
  return {
    state: {
      ...state,
      nextPlaySeq: nextSeq(state.nextPlaySeq),
      consecutiveConcealed: state.consecutiveConcealed + 1,
      stats: { ...state.stats, concealed: state.stats.concealed + 1 },
    },
    action: { kind: 'conceal' },
  };
}

/** Current playout delay this policy is imposing, in ms. */
export function targetDelayMs(state: JitterState): number {
  return state.targetDepthFrames * AUDIO_FRAME_MS;
}

// ---- internals -------------------------------------------------------------

/** RFC 3550 §6.4.1-shaped interarrival jitter over arrival times, feeding the
 *  adaptive target depth: target ≈ min + jitter expressed in frames. */
function observeArrival(state: JitterState, seq: number, nowMs: number): JitterState {
  const prev = state.lastArrival;
  if (!prev) return { ...state, lastArrival: { seq, atMs: nowMs } };

  const seqAdvance = seqDelta(prev.seq, seq);
  if (seqAdvance <= 0) return { ...state, lastArrival: { seq, atMs: nowMs } };

  const expectedMs = seqAdvance * AUDIO_FRAME_MS;
  const deviation = Math.abs(nowMs - prev.atMs - expectedMs);
  const jitterMs = state.jitterMs + (deviation - state.jitterMs) / 16;

  const wanted = state.config.minDepthFrames + Math.ceil(jitterMs / AUDIO_FRAME_MS);
  const targetDepthFrames = Math.max(
    state.config.minDepthFrames,
    // Grow immediately, shrink by at most one frame per observation so one
    // calm interval cannot collapse the cushion a jittery link still needs.
    Math.min(Math.max(wanted, state.targetDepthFrames - 1), state.config.maxDepthFrames),
  );

  return { ...state, jitterMs, targetDepthFrames, lastArrival: { seq, atMs: nowMs } };
}

function insertSorted(frames: readonly AudioFrame[], frame: AudioFrame): AudioFrame[] {
  const index = frames.findIndex((f) => seqNewer(f.seq, frame.seq));
  if (index === -1) return [...frames, frame];
  return [...frames.slice(0, index), frame, ...frames.slice(index)];
}
