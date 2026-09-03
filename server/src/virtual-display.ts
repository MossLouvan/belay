// Driver-backed virtual displays: the host renders at the client's exact
// resolution and refresh rate, decoupled from any physical monitor.
//
// This is the policy/validation layer for the OPT-IN virtual display driver
// feature (BELAY_VIRTUAL_DISPLAY=1). It is deliberately separate from
// displays.ts: that file *classifies* displays the OS already has, whatever
// created them; this file decides whether Belay itself may *create and
// destroy* one through the native helper, and validates every number a client
// sends before it can reach a driver.
//
// Platform backends (see docs/VIRTUAL-DISPLAY.md for status and build steps):
//   - Windows: server/native/win-display/ — a Belay-owned IddCx indirect
//     display driver derived from the SudoVDA/Microsoft-sample lineage
//     (MIT / CC0 / MS-PL — all permissive; no GPL anywhere in the chain, so a
//     proprietary host build can ship it). Driven over an ACL'd control
//     device by BelayHostVirtualDisplay.cs. WRITTEN BUT NOT COMPILED here.
//   - macOS: server/native/mac/VirtualDisplay.swift — CGVirtualDisplay, the
//     same private CoreGraphics API DeskPad (MIT) and BetterDisplay use. No
//     kernel driver, no install; the helper owns the display's lifetime.
//
// Nothing in the default capture path consults this module. With the flag off
// the routes answer with a clear refusal and the native helper is never asked.

import { productEnv } from './env.js';

/** A validated request to create a virtual display. */
export interface VirtualDisplayRequest {
  /** Pixel width, even, 640..7680. */
  width: number;
  /** Pixel height, even, 480..4320. */
  height: number;
  /** Refresh rate in Hz, integer, 24..240. */
  refreshHz: number;
}

export type VirtualDisplayParse =
  | { readonly ok: true; readonly request: VirtualDisplayRequest }
  | { readonly ok: false; readonly error: string };

// The driver advertises exactly what the client asked for, so these bounds are
// the product's promise, not the driver's ceiling. 7680x4320 is 8K — beyond it
// no client Belay ships can display the pixels, and the host would pay encode
// cost for nothing. Refresh below 24 breaks encoder rate assumptions; above
// 240 exceeds every client display Belay targets.
export const MIN_WIDTH = 640;
export const MAX_WIDTH = 7680;
export const MIN_HEIGHT = 480;
export const MAX_HEIGHT = 4320;
export const MIN_REFRESH_HZ = 24;
export const MAX_REFRESH_HZ = 240;
export const DEFAULT_REFRESH_HZ = 60;

/**
 * Whether the virtual display driver feature is enabled on this host.
 *
 * Opt-in and default-off on purpose: creating displays changes the host's
 * desktop topology (windows can move, resolutions can rearrange), and on
 * Windows it requires a separately installed driver. Off means the feature is
 * invisible — the default capture path is untouched.
 */
export function virtualDisplayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = productEnv('VIRTUAL_DISPLAY', env);
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function intField(value: unknown): number | undefined {
  // Strings are rejected: "1920" from a buggy client should surface as an
  // error, not be quietly coerced into working until the day it doesn't.
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value)) return undefined;
  return value;
}

/**
 * Validates an untrusted request body into a `VirtualDisplayRequest`.
 *
 * Everything here is a boundary check on client input BEFORE it reaches a
 * driver: the Windows control device re-validates in the driver itself
 * (defence in depth — the device object is ACL'd but ACLs are policy, not
 * proof), but no malformed value should ever get that far.
 *
 * Odd dimensions are rejected rather than rounded: H.264/HEVC encoders
 * require mod-2 dimensions, and silently changing what the client asked for
 * would make the streamed size disagree with the client's layout math.
 */
export function parseVirtualDisplayRequest(body: unknown): VirtualDisplayParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;

  const width = intField(record.width);
  if (width === undefined) return { ok: false, error: 'width must be an integer' };
  if (width < MIN_WIDTH || width > MAX_WIDTH) {
    return { ok: false, error: `width must be between ${MIN_WIDTH} and ${MAX_WIDTH}` };
  }
  if (width % 2 !== 0) return { ok: false, error: 'width must be even (encoder requirement)' };

  const height = intField(record.height);
  if (height === undefined) return { ok: false, error: 'height must be an integer' };
  if (height < MIN_HEIGHT || height > MAX_HEIGHT) {
    return { ok: false, error: `height must be between ${MIN_HEIGHT} and ${MAX_HEIGHT}` };
  }
  if (height % 2 !== 0) return { ok: false, error: 'height must be even (encoder requirement)' };

  let refreshHz = DEFAULT_REFRESH_HZ;
  if (record.refreshHz !== undefined && record.refreshHz !== null) {
    const parsed = intField(record.refreshHz);
    if (parsed === undefined) return { ok: false, error: 'refreshHz must be an integer' };
    if (parsed < MIN_REFRESH_HZ || parsed > MAX_REFRESH_HZ) {
      return {
        ok: false,
        error: `refreshHz must be between ${MIN_REFRESH_HZ} and ${MAX_REFRESH_HZ}`,
      };
    }
    refreshHz = parsed;
  }

  return { ok: true, request: { width, height, refreshHz } };
}

/**
 * The message a client sees when the feature is off. One string, one place,
 * so the route and any future callers refuse identically.
 */
export const VIRTUAL_DISPLAY_DISABLED_ERROR =
  'virtual display support is disabled on this host; set BELAY_VIRTUAL_DISPLAY=1 and restart (see docs/VIRTUAL-DISPLAY.md)';

// ---------------------------------------------------------------------------
// Phone-driven capture path (the Parsec-style TRUE resolution feature).
//
// The REST route above uses `parseVirtualDisplayRequest`, which REJECTS any
// out-of-range value: a script hitting the API deserves a 400, not a silently
// altered display. The live screen stream is different — the phone drives it
// through the `config` control message, and a resolution a hair outside the
// bounds (an odd phone logical size, an unusual aspect) must NUDGE to the
// nearest valid mode rather than tear the running stream down. So this half of
// the module CLAMPS instead of rejecting, and every decision below is a pure
// function so the wiring in index.ts stays a thin imperative shell around it.
// ---------------------------------------------------------------------------

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Round to the nearest even number the encoder will accept, within bounds. */
function clampEven(value: number, min: number, max: number): number {
  // mod-2: H.264/HEVC require even dimensions. Round to even first, then clamp,
  // so the clamp cannot re-introduce an odd bound (MIN/MAX are already even).
  const even = 2 * Math.round(value / 2);
  return clampInt(even, min, max);
}

/**
 * Coerce an untrusted `config`-message resolution into a valid request, or
 * `null` when the phone did not send a usable one.
 *
 * `null` (not a clamp to some default size) is the deliberate answer to a
 * missing or non-numeric width/height: guessing a resolution the phone never
 * asked for is worse than falling back to the physical downscale, which is
 * exactly what `null` selects downstream.
 */
export function clampVirtualDisplayRequest(body: unknown): VirtualDisplayRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const width = toFinite(record.width);
  const height = toFinite(record.height);
  if (width === null || height === null) return null;

  const refresh = toFinite(record.refreshHz);
  return {
    width: clampEven(width, MIN_WIDTH, MAX_WIDTH),
    height: clampEven(height, MIN_HEIGHT, MAX_HEIGHT),
    refreshHz: refresh === null
      ? DEFAULT_REFRESH_HZ
      : clampInt(refresh, MIN_REFRESH_HZ, MAX_REFRESH_HZ),
  };
}

function toFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read the desired virtual-display request out of a partial `config` update.
 *
 * Three-state on purpose, mirroring how `resolveStreamParams` treats an absent
 * field: `undefined` means "keep what the stream had", explicit `null` means
 * "tear the virtual display down and go back to the physical screen", and an
 * object is a new (clamped) resolution. Nothing else can change the mode, so a
 * malformed message can never silently strand the stream on a virtual display.
 */
export function resolveVirtualRequest(
  input: { readonly virtualDisplay?: unknown },
  current: VirtualDisplayRequest | null,
): VirtualDisplayRequest | null {
  if (!('virtualDisplay' in input) || input.virtualDisplay === undefined) return current;
  if (input.virtualDisplay === null) return null;
  return clampVirtualDisplayRequest(input.virtualDisplay);
}

/** Whether two resolved requests are the same mode — used to skip a needless
 *  destroy/recreate when the phone re-sends an unchanged config. */
export function sameRequest(
  a: VirtualDisplayRequest | null,
  b: VirtualDisplayRequest | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.width === b.width && a.height === b.height && a.refreshHz === b.refreshHz;
}

/** The capture mode the stream loop should use for the next frame. */
export interface CaptureMode {
  /** Non-null only when the host will actually capture a driver-backed display
   *  at this resolution; null means the physical-screen downscale path. */
  readonly virtual: VirtualDisplayRequest | null;
}

/**
 * The single fallback decision, isolated and pure so it can be tested to death:
 * a true-resolution request takes effect ONLY when the host both has the
 * feature enabled and actually created the display. Anytime that is not true
 * the answer is the physical downscale path — the shipping JPEG stream must
 * never break because the phone asked for something this host cannot do.
 */
export function selectCaptureMode(
  requested: VirtualDisplayRequest | null,
  hostHasVirtualDisplay: boolean,
): CaptureMode {
  return { virtual: hostHasVirtualDisplay ? requested : null };
}
