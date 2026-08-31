// The pure vocabulary of screen recording on the phone: the host's status
// shape, the boundary parser for it, and the strings the strip and the dock
// key display. No react-native imports — this file runs under node:test.
//
// The recording itself happens on the computer (the same machine Claude Code
// reads files from); the phone only starts, stops and hands it off, so all
// this module ever holds is counters.

export type RecordPhase = 'idle' | 'recording' | 'ready';

export type AutoStopReason = 'duration' | 'frames' | 'bytes' | 'errors';

export interface RecordingStatus {
  readonly state: RecordPhase;
  readonly seconds: number;
  readonly frames: number;
  readonly dropped: number;
  readonly bytes: number;
  readonly autoStopped?: AutoStopReason;
  readonly lastError?: string;
}

export const IDLE_RECORDING: RecordingStatus = Object.freeze({
  state: 'idle',
  seconds: 0,
  frames: 0,
  dropped: 0,
  bytes: 0,
});

/** Poll cadence while a recording runs — the strip's clock ticks off this. */
export const RECORD_POLL_MS = 1000;

const PHASES: readonly RecordPhase[] = ['idle', 'recording', 'ready'];
const REASONS: readonly AutoStopReason[] = ['duration', 'frames', 'bytes', 'errors'];

const countOf = (raw: unknown): number =>
  typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;

/**
 * Parse the host's `/recording/*` reply. The host is ours, but the payload
 * still crosses a network boundary: anything unrecognised collapses to the
 * idle status rather than propagating NaN into the strip's clock.
 */
export function parseRecordingStatus(raw: unknown): RecordingStatus {
  if (typeof raw !== 'object' || raw === null) return IDLE_RECORDING;
  const msg = raw as Record<string, unknown>;
  const state = PHASES.find((p) => p === msg.state);
  if (!state) return IDLE_RECORDING;
  const autoStopped = REASONS.find((r) => r === msg.autoStopped);
  return {
    state,
    seconds: countOf(msg.seconds),
    frames: countOf(msg.frames),
    dropped: countOf(msg.dropped),
    bytes: countOf(msg.bytes),
    ...(autoStopped ? { autoStopped } : {}),
    ...(typeof msg.lastError === 'string' && msg.lastError ? { lastError: msg.lastError } : {}),
  };
}

/** `0:07`, `1:23`, `12:05` — a recording clock, not a duration essay. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The strip's one line of observed truth (docs/DESIGN.md §11.4): the state
 * name, then the clock and the frame count — the two numbers that prove the
 * recorder is alive and say what a handoff would contain.
 */
export function stripText(status: RecordingStatus): string {
  const clock = formatClock(status.seconds);
  const frames = `${status.frames} frame${status.frames === 1 ? '' : 's'}`;
  if (status.state === 'recording') return `Recording · ${clock} · ${frames}`;
  return `Recorded · ${clock} · ${frames}`;
}

/** What the dock key does next, which is what it must say (§11.3). */
export function recordKeyLabel(phase: RecordPhase): string {
  if (phase === 'recording') return 'Stop';
  if (phase === 'ready') return 'Send';
  return 'Rec';
}

/**
 * Why the host stopped without being asked — surfaced once, on the strip,
 * because a recording that silently truncated itself would hand Claude a
 * clip missing exactly the moment the user waited for.
 */
export function autoStopMessage(reason: AutoStopReason | undefined): string | null {
  switch (reason) {
    case 'duration': return 'Stopped at the 5 minute limit.';
    case 'frames': return 'Stopped at the frame limit.';
    case 'bytes': return 'Stopped at the size limit.';
    case 'errors': return 'Stopped — the computer could not capture the screen.';
    default: return null;
  }
}
