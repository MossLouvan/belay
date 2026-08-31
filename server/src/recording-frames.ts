// The pure half of screen recording: which frames survive, what they are
// called, and what Claude is told about them.
//
// A recording exists to be *read by Claude Code*, which reads images, not
// video — so the unit of everything here is a JPEG still, and the hard
// problem is not capturing frames but refusing to keep too many of them.
// Thirty seconds at the live stream's rate would be hundreds of images;
// Claude cannot usefully read hundreds of images and the context cost would
// drown the answer. So frames are captured slowly, exact repeats are dropped
// at capture time (a screen that isn't changing yields byte-identical JPEGs,
// and re-reading the same picture teaches Claude nothing), and the survivors
// are thinned to a fixed ceiling before they ever touch the disk.

/** How a recording paces and bounds itself. Every number is a hard cap. */
export const RECORDING = Object.freeze({
  /**
   * One capture every 500ms. Two frames a second is enough to catch a dialog
   * flashing, a test line scrolling past or a layout jumping — the things a
   * person records a bug for — while adding at most two extra captures per
   * second to the native helper's serialized queue, so the live stream a
   * viewer may have open at the same time loses at most one capture's worth
   * of latency, never its frame rate.
   */
  intervalMs: 500,
  /** Capture width. 1024px keeps UI text legible to Claude without bloating each file. */
  width: 1024,
  /** JPEG quality. Higher than the live stream's default: these are read, not glanced at. */
  quality: 60,
  /** A recording that outlives this stops itself — a forgotten recorder must not run all day. */
  maxDurationMs: 5 * 60 * 1000,
  /** Ceiling on frames held in memory while recording (5 min at 2fps, exactly). */
  maxFrames: 600,
  /** Ceiling on the bytes held in memory while recording. */
  maxBytes: 48 * 1024 * 1024,
  /** How many frames at most are written to disk and handed to Claude. */
  maxKept: 24,
  /** Recordings kept per project; older ones are deleted on each delivery. */
  maxSaved: 5,
  /** Consecutive capture failures before the recording gives up on its own. */
  maxConsecutiveErrors: 10,
} as const);

/**
 * Whether a freshly captured frame is worth keeping next to the previous one.
 *
 * Byte-for-byte equality only, on purpose: both helpers encode
 * deterministically, so an unchanged screen produces an identical JPEG, and
 * anything cleverer (perceptual hashing, size deltas) would need to decode
 * the image on the host for a marginal gain. A frame that differs by one
 * blinking cursor is kept — the thinning pass bounds the total either way.
 */
export function isNewFrame(previous: string | undefined, next: string): boolean {
  return previous === undefined || previous !== next;
}

/**
 * Thin a frame list to at most `max`, evenly spaced, always keeping the first
 * and last frame — the before and the after are the two stills a recording is
 * least allowed to lose. Returns the input array itself when nothing must go,
 * so callers can cheaply detect "no thinning happened".
 */
export function thinFrames<T>(frames: readonly T[], max: number): readonly T[] {
  if (max <= 0) return [];
  if (frames.length <= max) return frames;
  if (max === 1) return [frames[0]];
  const step = (frames.length - 1) / (max - 1);
  const picked: T[] = [];
  for (let i = 0; i < max; i++) picked.push(frames[Math.round(i * step)]);
  return picked;
}

/**
 * `frame-01.jpg` … zero-padded to the width of the largest index, so a plain
 * alphabetical listing — which is how both Claude and a shell will meet these
 * files — is also chronological order.
 */
export function frameName(index: number, total: number): string {
  const width = Math.max(2, String(total).length);
  return `frame-${String(index + 1).padStart(width, '0')}.jpg`;
}

/**
 * `rec-20260831-142051` — sortable-as-text, so "delete the oldest" is a plain
 * string sort, and readable enough that a human meeting the folder in a file
 * browser knows when it was made. Local time, because the human comparing it
 * to "when the bug happened" thinks in local time.
 */
export function recordingDirName(startedAt: number): string {
  const d = new Date(startedAt);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `rec-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const RECORDING_DIR_PATTERN = /^rec-\d{8}-\d{6}$/;

/**
 * Which saved recordings to delete so at most `maxSaved` remain — the disk
 * lifecycle in one pure function. Names matching the recording pattern sort
 * chronologically as strings; anything not matching the pattern is left
 * alone, because deleting files this module did not create is how a cleanup
 * routine becomes a data-loss bug.
 */
export function staleRecordings(dirNames: readonly string[], maxSaved: number): readonly string[] {
  const ours = dirNames.filter((name) => RECORDING_DIR_PATTERN.test(name));
  const newestFirst = [...ours].sort().reverse();
  return newestFirst.slice(Math.max(0, maxSaved));
}

/**
 * The prompt handed to Claude alongside the frames. It references the frames
 * by their real relative path inside the session's own project — the one
 * place Claude Code reads without ceremony — spells out the order, and puts
 * the user's note (when there is one) where the task goes.
 */
export function buildPrompt(args: {
  readonly relDir: string;
  readonly frameNames: readonly string[];
  readonly seconds: number;
  readonly note?: string;
}): string {
  const { relDir, frameNames, seconds, note } = args;
  const count = frameNames.length;
  const first = frameNames[0] ?? '';
  const last = frameNames[count - 1] ?? '';
  const span = count === 1 ? first : `${first} through ${last}`;
  const ask = note?.trim()
    ? note.trim()
    : 'describe what happens over the course of the recording — what changes, when, and anything that looks wrong.';
  return [
    `I recorded this computer's screen: ${count} JPEG frame${count === 1 ? '' : 's'} captured over ${seconds}s, in chronological order, in ${relDir}/ inside this project.`,
    `Read every frame in order (${span}), then: ${ask}`,
    'The frames are throwaway capture files — do not commit them.',
  ].join('\n\n');
}
