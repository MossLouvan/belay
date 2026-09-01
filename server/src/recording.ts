// Host-side screen recording, for handing to a Claude Code session.
//
// The recording is made and kept HERE, on the machine whose screen it shows,
// because that is also the machine Claude Code runs on and reads files from.
// Round-tripping frames through the phone would add a lossy hop, cellular
// bandwidth and latency to a pipeline whose producer and consumer share a
// disk; the phone is the remote control, so it only ever sees counters.
//
// While recording, frames live in memory (bounded — see RECORDING in
// recording-frames.ts) and nothing touches the disk. Files are written only
// at delivery, into the chosen session's own project folder, so a discarded
// recording leaves zero bytes behind and there is never an orphaned spool to
// sweep. The capture loop is paced independently of the live `/ws/screen`
// stream and awaits each capture before scheduling the next, so it adds at
// most one in-flight command to the native helper's serialized queue — it can
// delay a live frame by one capture, never starve the stream.

import { mkdir, readdir, rm, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { native } from './native.js';
import { isDenied, isInsideRoots } from './files.js';
import {
  RECORDING,
  buildPrompt,
  frameName,
  isNewFrame,
  recordingDirName,
  staleRecordings,
  thinFrames,
} from './recording-frames.js';

export type RecorderState = 'idle' | 'recording' | 'ready';

/** Why a recording ended without the user asking it to. */
export type AutoStopReason = 'duration' | 'frames' | 'bytes' | 'errors';

export interface RecorderStatus {
  readonly state: RecorderState;
  readonly startedAt?: number;
  readonly seconds: number;
  readonly frames: number;
  /** Byte-identical repeats dropped at capture time. */
  readonly dropped: number;
  readonly bytes: number;
  readonly screen?: number;
  readonly autoStopped?: AutoStopReason;
  readonly lastError?: string;
}

export interface Delivery {
  readonly dir: string;
  readonly relDir: string;
  readonly frames: readonly string[];
  readonly prompt: string;
  readonly seconds: number;
}

interface CapturedFrame {
  readonly data: string;
  readonly at: number;
}

type CaptureFn = (width: number, quality: number, screen?: number) => Promise<{ data: string; bytes: number }>;

export interface RecorderOptions {
  readonly capture?: CaptureFn;
  readonly intervalMs?: number;
  readonly maxDurationMs?: number;
  readonly maxFrames?: number;
  readonly maxBytes?: number;
  readonly maxConsecutiveErrors?: number;
}

const defaultCapture: CaptureFn = async (width, quality, screen) => {
  const frame = await native.capture(width, quality, false, screen);
  return { data: frame.data, bytes: frame.bytes };
};

/**
 * One recording at a time, machine-wide. That is a design choice, not a
 * shortage: the host has one user, and two overlapping recordings of the same
 * screen would double the capture load for two copies of the same pixels.
 *
 * State machine: idle → recording → ready → idle. `ready` holds the stopped
 * frames until they are delivered to a session or discarded; starting a new
 * recording from `ready` discards the old one deliberately — the user's most
 * recent intent wins over a review they walked away from.
 */
export class Recorder {
  private readonly capture: CaptureFn;
  private readonly intervalMs: number;
  private readonly maxDurationMs: number;
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private readonly maxConsecutiveErrors: number;

  private state: RecorderState = 'idle';
  private frames: CapturedFrame[] = [];
  private bytes = 0;
  private dropped = 0;
  private startedAt = 0;
  private stoppedAt = 0;
  private screen: number | undefined;
  private autoStopped: AutoStopReason | undefined;
  private lastError: string | undefined;
  /** Increments on every start/stop; a stale loop iteration sees it and quits. */
  private generation = 0;

  constructor(options: RecorderOptions = {}) {
    this.capture = options.capture ?? defaultCapture;
    this.intervalMs = options.intervalMs ?? RECORDING.intervalMs;
    this.maxDurationMs = options.maxDurationMs ?? RECORDING.maxDurationMs;
    this.maxFrames = options.maxFrames ?? RECORDING.maxFrames;
    this.maxBytes = options.maxBytes ?? RECORDING.maxBytes;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? RECORDING.maxConsecutiveErrors;
  }

  status(): RecorderStatus {
    const end = this.state === 'recording' ? Date.now() : this.stoppedAt;
    return {
      state: this.state,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      seconds: this.startedAt ? Math.max(0, Math.round((end - this.startedAt) / 1000)) : 0,
      frames: this.frames.length,
      dropped: this.dropped,
      bytes: this.bytes,
      ...(this.screen === undefined ? {} : { screen: this.screen }),
      ...(this.autoStopped ? { autoStopped: this.autoStopped } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  start(screen?: number): RecorderStatus {
    if (this.state === 'recording') throw new Error('a recording is already running');
    this.state = 'recording';
    this.frames = [];
    this.bytes = 0;
    this.dropped = 0;
    this.startedAt = Date.now();
    this.stoppedAt = 0;
    this.screen = screen;
    this.autoStopped = undefined;
    this.lastError = undefined;
    this.generation += 1;
    void this.loop(this.generation);
    return this.status();
  }

  stop(): RecorderStatus {
    if (this.state !== 'recording') throw new Error('no recording is running');
    this.finish(undefined);
    return this.status();
  }

  discard(): RecorderStatus {
    if (this.state === 'recording') this.finish(undefined);
    this.reset();
    return this.status();
  }

  /**
   * Write the kept frames into `cwd` (a Claude session's project folder) and
   * build the prompt that references them. The caller owns actually sending
   * the prompt — this module knows about files, not about agent sessions.
   *
   * `cwd` arrives from a session the agent module already confined at
   * creation, but it is re-checked here anyway: a write primitive must not
   * trust that some other module's invariant still holds.
   */
  async deliver(cwd: string, note?: string): Promise<Delivery> {
    if (this.state !== 'ready') throw new Error('there is no stopped recording to send');
    if (this.frames.length === 0) throw new Error('the recording captured no frames');

    const realCwd = await realpath(cwd);
    if (!isInsideRoots(realCwd) || isDenied(realCwd)) {
      throw new Error('that project folder is outside the allowed folders');
    }

    const kept = thinFrames(this.frames, RECORDING.maxKept);
    const dirName = recordingDirName(this.startedAt);
    const relDir = join('.belay', 'recordings', dirName);
    const recordingsDir = join(realCwd, '.belay', 'recordings');
    const dir = join(recordingsDir, dirName);
    await mkdir(dir, { recursive: true });

    const names = kept.map((_, i) => frameName(i, kept.length));
    await Promise.all(
      kept.map((frame, i) => writeFile(join(dir, names[i]), Buffer.from(frame.data, 'base64'))),
    );

    await pruneRecordings(recordingsDir, RECORDING.maxSaved);

    const seconds = Math.max(1, Math.round((this.stoppedAt - this.startedAt) / 1000));
    const prompt = buildPrompt({ relDir, frameNames: names, seconds, note });
    this.reset();
    return { dir, relDir, frames: names, prompt, seconds };
  }

  private finish(reason: AutoStopReason | undefined): void {
    this.state = this.frames.length > 0 ? 'ready' : 'idle';
    this.stoppedAt = Date.now();
    this.autoStopped = reason;
    this.generation += 1;
  }

  private reset(): void {
    this.state = 'idle';
    this.frames = [];
    this.bytes = 0;
    this.dropped = 0;
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.screen = undefined;
    this.autoStopped = undefined;
    this.lastError = undefined;
  }

  /**
   * The capture loop. Paced start-to-start like the live stream's, and — the
   * part that protects the live stream — strictly one capture in flight: the
   * next tick is only scheduled after the previous capture settles, so this
   * loop can never queue up behind a slow helper and turn into a backlog.
   */
  private async loop(generation: number): Promise<void> {
    let consecutiveErrors = 0;
    while (this.state === 'recording' && this.generation === generation) {
      const tick = Date.now();
      if (tick - this.startedAt >= this.maxDurationMs) { this.finish('duration'); return; }
      try {
        const frame = await this.capture(RECORDING.width, RECORDING.quality, this.screen);
        consecutiveErrors = 0;
        if (this.state !== 'recording' || this.generation !== generation) return;
        const previous = this.frames[this.frames.length - 1]?.data;
        if (isNewFrame(previous, frame.data)) {
          this.frames.push({ data: frame.data, at: Date.now() });
          this.bytes += frame.bytes;
          if (this.frames.length >= this.maxFrames) { this.finish('frames'); return; }
          if (this.bytes >= this.maxBytes) { this.finish('bytes'); return; }
        } else {
          this.dropped += 1;
        }
      } catch (e: unknown) {
        this.lastError = e instanceof Error ? e.message : String(e);
        consecutiveErrors += 1;
        if (consecutiveErrors >= this.maxConsecutiveErrors) { this.finish('errors'); return; }
      }
      const elapsed = Date.now() - tick;
      if (elapsed < this.intervalMs) await sleep(this.intervalMs - elapsed);
    }
  }
}

/** Delete saved recordings beyond the cap. Missing dir means nothing to prune. */
export async function pruneRecordings(recordingsDir: string, maxSaved: number, pattern?: RegExp): Promise<void> {
  let names: string[];
  try {
    names = await readdir(recordingsDir);
  } catch {
    return;
  }
  const stale = staleRecordings(names, maxSaved, pattern);
  await Promise.all(stale.map((name) => rm(join(recordingsDir, name), { recursive: true, force: true })));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const recorder = new Recorder();
