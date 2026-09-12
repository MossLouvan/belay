// Pure decisions behind the desktop route's chrome — what shows, what hides,
// what a key does next. Every one used to be an inline expression in
// app/(home)/screen.tsx; here node can test them and the route reads as
// composition. No React, no react-native.

import type { Size } from './model';
import type { RecordPhase } from './record';
import type { StreamSettings } from './stream-settings-sheet';
import type { PendingButton, PointerMode } from './viewport';

export interface WindowMetrics {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/**
 * "Match my phone" needs the device's own pixel size (logical points × the
 * display scale), so the host can render a desktop of exactly this shape.
 * Normalized: always the LARGER dimension as width, so portrait and landscape
 * report the same device size (the host renders it, we rotate) — and a
 * keyboard shrinking the window's height on Android keeps the same max, so
 * it never reshapes the virtual display mid-session.
 */
export function normalizedDeviceSize(window: WindowMetrics): Size {
  const w = Math.max(window.width, window.height);
  const h = Math.min(window.width, window.height);
  return { w: w * window.scale, h: h * window.scale };
}

export const isLandscape = (width: number, height: number): boolean => width > height;

export interface ImmersiveInputs {
  readonly gaming: boolean;
  readonly fullscreen: boolean;
  readonly landscape: boolean;
}

/** Immersive = the chrome floats: gaming, the portrait Full toggle, or sideways. */
export const isImmersive = ({ gaming, fullscreen, landscape }: ImmersiveInputs): boolean =>
  gaming || fullscreen || landscape;

export interface StageOffsetInputs {
  readonly immersive: boolean;
  /** The machine panel's measured height, px. */
  readonly boxH: number;
  /** The letterboxed stage's height, px. */
  readonly stageH: number;
  readonly insetTop: number;
  readonly insetBottom: number;
}

/**
 * How far DOWN the stage sits inside the immersive panel, px.
 *
 * The panel is top-aligned (stage-view.tsx) because centering it in PORTRAIT
 * CHROME strands the picture under the header with the tap targets — the
 * "tap → screen on bottom half" bug. Immersive is the other shape entirely:
 * the panel is the whole display and the picture is letterboxed to the remote
 * aspect, so a 16:9 desktop on an upright phone is ~250pt of picture pinned to
 * y=0 — its top slice behind the status bar and the Dynamic Island, 600pt of
 * black below it. This centers that short stage inside the SAFE AREA instead,
 * which is what the rest of the immersive code already assumes (the pad hint
 * stands down immersive precisely because "immersive centers the stage").
 *
 * A stage that already fills the safe area — every landscape one, where the
 * picture is meant to bleed edge to edge under the notch — offsets by zero and
 * is left exactly as it was.
 */
export const immersiveStageOffset = (
  { immersive, boxH, stageH, insetTop, insetBottom }: StageOffsetInputs
): number => {
  if (!immersive || boxH <= 0 || stageH <= 0) return 0;
  const safeH = boxH - Math.max(0, insetTop) - Math.max(0, insetBottom);
  if (stageH >= safeH) return 0;
  return Math.max(0, insetTop) + (safeH - stageH) / 2;
};

export interface RotationInputs {
  readonly gaming: boolean;
  readonly landscape: boolean;
  readonly wasLandscape: boolean;
  readonly fullscreen: boolean;
}

/**
 * Landscape is the fullscreen gesture, and the explicit Full toggle is a
 * portrait-only idea, so a FRESH rotation clears it — otherwise coming back
 * upright would strand the user in a fullscreen they never chose. Leaving
 * Gaming while its landscape lock is restoring must preserve the choice.
 */
export const shouldClearFullscreen = ({ gaming, landscape, wasLandscape, fullscreen }: RotationInputs): boolean =>
  !gaming && landscape && !wasLandscape && fullscreen;

export interface DockHideInputs {
  readonly immersive: boolean;
  readonly keyboardOpen: boolean;
}

/**
 * The floating dock auto-hides only while immersive AND idle: with the text
 * field or the key bar open the user is actively working the bar, and hiding
 * it under their thumbs would be hostile.
 */
export const dockAutoHides = ({ immersive, keyboardOpen }: DockHideInputs): boolean =>
  immersive && !keyboardOpen;

/** The one-shot right/double buttons toggle: pressing the armed one disarms it. */
export const toggleArmedButton = (current: PendingButton, target: Exclude<PendingButton, 'none'>): PendingButton =>
  current === target ? 'none' : target;

export interface HintInputs {
  readonly immersive: boolean;
  /** null while the stored flag loads — the hint never flashes on first paint. */
  readonly hintSeen: boolean | null;
  readonly connected: boolean;
}

/** First-run hint: shown in portrait, once the flag has loaded as unseen. */
export const hintVisible = ({ immersive, hintSeen, connected }: HintInputs): boolean =>
  !immersive && hintSeen === false && connected;

/** The header title: the host's name minus the mDNS suffix, or a fallback. */
export const headerTitle = (hostName: string | undefined): string =>
  (hostName || 'Screen').replace(/\.local$/i, '');

/** The TOOLS/Agent key badge: a count, or nothing at all. */
export const agentBadge = (waitingCount: number): number | null => (waitingCount > 0 ? waitingCount : null);

export type RecordKeyAction = 'start' | 'stop' | 'review';

/** One key, three meanings, in the order the recorder's loop runs. */
export const recordKeyAction = (phase: RecordPhase): RecordKeyAction =>
  phase === 'idle' ? 'start' : phase === 'recording' ? 'stop' : 'review';

export interface PanelStateInputs {
  readonly captureBlocked: boolean;
  readonly frameUri: string | null;
  readonly bwp: unknown;
}

/**
 * A live H.264 stream is a picture even before any JPEG frame has arrived —
 * and none ever will while it is up, so keying the overlay off `frameUri`
 * alone would leave the "connecting" panel on top of working video.
 */
export const panelStateShown = ({ captureBlocked, frameUri, bwp }: PanelStateInputs): boolean =>
  captureBlocked || (!frameUri && !bwp);

export interface CrosshairInputs {
  readonly gaming: boolean;
  readonly mode: PointerMode;
  /** The deadspace pad drove the cursor a moment ago. */
  readonly padCursor: boolean;
  readonly hasPicture: boolean;
}

/** The visible cursor: trackpad mode or a recent pad touch, over a real picture. */
export const crosshairShown = ({ gaming, mode, padCursor, hasPicture }: CrosshairInputs): boolean =>
  !gaming && (mode === 'trackpad' || padCursor) && hasPicture;

/**
 * Where the open type row lives is a platform constant (so the Input never
 * remounts and drops focus). Only iOS overlays its keyboard on the app — there
 * the row floats and rides the keyboard's top edge. Android's adjustResize
 * shrinks the window above the keyboard and the web has no on-screen keyboard
 * at all, so both keep the row inline in the control column.
 */
export const typeRowFloats = (os: string): boolean => os === 'ios';

/** The Performance settings row's subtitle: "60 Hz • Auto • H264". */
export const performanceSummary = (settings: StreamSettings): string =>
  `${settings.fps} Hz • ${settings.bitrateMbps === 0 ? 'Auto' : `${settings.bitrateMbps} Mbps`} • ${settings.codec.toUpperCase()}`;
