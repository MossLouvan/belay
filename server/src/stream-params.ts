// Validation for the screen-stream tuning parameters (width, quality, fps).
//
// These arrive from two places — the WebSocket query string at connect time and
// a `config` control message mid-stream — and previously only the second path
// clamped them. That split is what made them dangerous:
//
//   * `?fps=100000` produced a frame budget of 0.01ms, i.e. an uncapped capture
//     loop pinning a CPU core.
//   * `{"fps":"abc"}` produced NaN. `Math.max(1, Math.min(30, NaN))` is NaN, and
//     `elapsed < NaN` is *false*, so the pacing sleep was skipped on every
//     iteration — the same uncapped loop, reached through a value that looks
//     like it was clamped.
//
// So the rule is: one clamp, applied identically to both paths, that treats any
// non-finite value as absent rather than propagating it.

/** Inclusive bounds plus the value used when none is supplied. */
export interface Range {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

export const STREAM_LIMITS = {
  /** Capture width in pixels. The host scales to this before encoding. */
  width: { min: 240, max: 1920, fallback: 1024 },
  /** JPEG quality. Below ~20 the picture stops being useful. */
  quality: { min: 20, max: 90, fallback: 50 },
  /** Frames per second. The ceiling bounds host CPU, not just bandwidth. */
  fps: { min: 1, max: 30, fallback: 12 },
} as const satisfies Record<string, Range>;

/**
 * Coerce an untrusted value into `range`.
 *
 * Only two things are accepted: a finite number, and a string that parses to
 * one (which is how query parameters arrive). Everything else yields the
 * fallback. This never returns NaN, which is the whole point.
 *
 * Note the deliberate refusal to lean on `Number()` for the general case:
 * `Number(null)` and `Number([])` are both `0`, so blanket coercion would
 * quietly accept a null or an array as "zero" and clamp it to the range
 * minimum. A caller sending those is malfunctioning, and the safe default is
 * the fallback, not the cheapest setting.
 */
export function clampToRange(raw: unknown, range: Range): number {
  const value = toFiniteNumber(raw);
  if (value === null) return range.fallback;
  return Math.round(Math.min(range.max, Math.max(range.min, value)));
}

/** A finite number, or null if `raw` is not one and does not parse as one. */
function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Highest monitor index accepted from a client. Purely a sanity bound on
 * untrusted input — the native helper additionally validates the index against
 * the monitors that actually exist and falls back to the primary.
 */
export const MAX_SCREEN_INDEX = 31;

/**
 * Coerce an untrusted monitor index, or undefined for "the host's primary".
 *
 * Undefined rather than a fallback number, because the absence is meaningful:
 * it is what old phones send, and the helper maps it to the primary monitor —
 * whose index within the screens list the server has no business guessing.
 */
export function screenIndexOf(raw: unknown): number | undefined {
  const value = toFiniteNumber(raw);
  if (value === null) return undefined;
  const index = Math.round(value);
  if (index < 0 || index > MAX_SCREEN_INDEX) return undefined;
  return index;
}

/** The stream parameters, all guaranteed finite and in range. */
export interface StreamParams {
  readonly width: number;
  readonly quality: number;
  readonly fps: number;
  /** Monitor index to capture; absent means the host's primary. */
  readonly screen?: number;
}

/**
 * Build a full parameter set from untrusted values, falling back per-field.
 * `current` supplies the value for any field left absent, which is what makes
 * this usable for a partial `config` update as well as the initial connect.
 */
export function resolveStreamParams(
  input: { readonly w?: unknown; readonly q?: unknown; readonly fps?: unknown; readonly screen?: unknown },
  current: StreamParams = {
    width: STREAM_LIMITS.width.fallback,
    quality: STREAM_LIMITS.quality.fallback,
    fps: STREAM_LIMITS.fps.fallback,
  },
): StreamParams {
  // Unlike the three tuned values, a rubbish screen index resolves to
  // undefined (the primary monitor), not a clamp: pointing the capture at
  // whatever monitor happens to sit at the clamped index would be arbitrary.
  const screen = present(input.screen) ? screenIndexOf(input.screen) : current.screen;
  return {
    width: present(input.w) ? clampToRange(input.w, STREAM_LIMITS.width) : current.width,
    quality: present(input.q) ? clampToRange(input.q, STREAM_LIMITS.quality) : current.quality,
    fps: present(input.fps) ? clampToRange(input.fps, STREAM_LIMITS.fps) : current.fps,
    ...(screen === undefined ? {} : { screen }),
  };
}

/**
 * Whether the caller supplied this field at all.
 *
 * Absent means "keep what you had". Note that a *present but rubbish* value
 * (`"abc"`) is deliberately not treated as absent — it is clamped to the
 * fallback instead, so a client sending garbage gets a safe default rather than
 * silently keeping a previously negotiated high-cost setting.
 */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}
