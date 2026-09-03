// Shared vocabulary for the remote-screen tab: tuning constants, the quality
// presets, the on-screen key list and the small pure helpers everything else
// builds on.
//
// This lives under `src/` rather than next to the route because every file
// inside `app/app/(tabs)/` is picked up by expo-router's route context and would
// register as an extra tab.

export interface Size {
  readonly w: number;
  readonly h: number;
}

export const EMPTY_SIZE: Size = Object.freeze({ w: 0, h: 0 });

export type QualityId = 'smooth' | 'balanced' | 'sharp';

export interface QualityPreset {
  readonly id: QualityId;
  readonly label: string;
  /** Capture width in px (host clamps 240..1920). */
  readonly w: number;
  /** JPEG quality (host clamps 20..90). */
  readonly q: number;
  /** Target frame rate (host clamps 1..30). */
  readonly fps: number;
  readonly hint: string;
}

export const QUALITY: readonly QualityPreset[] = Object.freeze([
  {
    id: 'smooth',
    label: 'Smooth',
    w: 720,
    q: 35,
    fps: 20,
    hint: 'Softer picture, highest frame rate. Best on cellular or a slow Tailscale hop.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    w: 1024,
    q: 50,
    fps: 12,
    hint: 'The default. Readable text at a comfortable frame rate.',
  },
  {
    id: 'sharp',
    label: 'Sharp',
    w: 1600,
    q: 78,
    fps: 8,
    hint: 'Crisp small text for code and terminals, at fewer frames per second.',
  },
]);

export const DEFAULT_QUALITY: QualityId = 'balanced';

export const findQuality = (id: QualityId): QualityPreset =>
  QUALITY.find((preset) => preset.id === id) ?? QUALITY[1];

export const STREAM = Object.freeze({
  statsIntervalMs: 1000,
  stallAfterMs: 4000,
  backoffBaseMs: 1000,
  backoffMaxMs: 15000,
  infoPollMs: 15000,
  toastMs: 4000,
});

export const GESTURE = Object.freeze({
  tapSlopPx: 8,
  longPressMs: 480,
  minScale: 1,
  maxScale: 6,
  zoomStep: 1.6,
  pinchThreshold: 0.06,
  scrollThresholdPx: 10,
  pxPerScrollNotch: 34,
  /**
   * Scroll sensitivity: multiplies finger travel before it is notched into
   * wheel units, for the two-finger gesture and scroll mode alike. At 1 a
   * notch costs the full `pxPerScrollNotch` of travel; at 1.6 it costs ~21px,
   * so a screen-height drag moves the page meaningfully further. "Still too
   * slow" and "too twitchy" are both answered here, in one edit.
   */
  scrollGain: 1.6,
  maxNotchesPerSend: 8,
  moveThrottleMs: 40,
  // Tuned down from 60 alongside scrollGain: a higher gain packs more notches
  // into each send, and stretching the same delta over fewer, larger events
  // is what made fast drags feel steppy.
  scrollThrottleMs: 45,
  /** Centroid travel that commits a three-finger swipe. */
  swipeThresholdPx: 48,
  /** How decisively one axis must beat the other before a swipe commits. */
  swipeAxisRatio: 1.5,
  friction: 0.93,
  minMomentumPx: 0.4,
  trackpadGain: 0.85,
  /** Frame budget assumed for the momentum decay, in ms. */
  frameMs: 16,
  /** Edge detection thresholds for 2-finger gestures (Notification Center, etc). */
  edgeThresholdPx: 60,
  cornerThresholdPx: 80,
  edgeSwipeThresholdPx: 40,
});

export interface KeySpec {
  /** Stable testID suffix. Never derived from the platform-dependent label. */
  readonly id: string;
  readonly label: string;
  readonly key: string;
  readonly mods?: readonly string[];
  /** Label and modifiers used when the host reports macOS. */
  readonly macLabel?: string;
  readonly macMods?: readonly string[];
  /**
   * Key sent when the host reports macOS, for shortcuts whose chord lands on
   * a different key entirely (region screenshot is ⌘⇧4 on a Mac but Win+⇧+S
   * on Windows). Falls back to `key` — most shortcuts differ only in mods.
   */
  readonly macKey?: string;
  /**
   * What the chord does, spoken by screen readers in place of the visual
   * label — VoiceOver reading "⌘⇧4" aloud helps nobody.
   */
  readonly action?: string;
  /**
   * Holding the cap repeats the key, the way a physical keyboard does (see
   * repeat.ts). Only for keys whose effect is safe to apply many times in a
   * row and is visibly incremental — deleting a character, moving a caret.
   * Never for anything that opens, closes, submits or switches: a held Enter
   * or Ctrl+W would fire twenty times before the finger lifted.
   */
  readonly repeatable?: boolean;
}

export const KEYS: readonly KeySpec[] = Object.freeze([
  { id: 'Esc', label: 'Esc', key: 'escape' },
  { id: 'Tab', label: 'Tab', key: 'tab' },
  { id: 'Enter', label: 'Enter', key: 'enter' },
  { id: 'Bksp', label: 'Bksp', key: 'backspace', repeatable: true },
  { id: 'Ctrl+C', label: 'Ctrl+C', key: 'c', mods: ['ctrl'], macLabel: '⌘C', macMods: ['cmd'], action: 'Copy' },
  { id: 'Ctrl+V', label: 'Ctrl+V', key: 'v', mods: ['ctrl'], macLabel: '⌘V', macMods: ['cmd'], action: 'Paste' },
  { id: 'Win', label: 'Win', key: 'win', macLabel: 'Cmd' },
  { id: 'Left', label: 'Left', key: 'left' },
  { id: 'Up', label: 'Up', key: 'up' },
  { id: 'Down', label: 'Down', key: 'down' },
  { id: 'Right', label: 'Right', key: 'right' },
  { id: 'Ctrl+A', label: 'Ctrl+A', key: 'a', mods: ['ctrl'], macLabel: '⌘A', macMods: ['cmd'], action: 'Select all' },
  { id: 'Ctrl+Z', label: 'Ctrl+Z', key: 'z', mods: ['ctrl'], macLabel: '⌘Z', macMods: ['cmd'], action: 'Undo' },
  { id: 'Alt+Tab', label: 'Alt+Tab', key: 'tab', mods: ['alt'], macLabel: '⌘Tab', macMods: ['cmd'], action: 'Switch app' },
  { id: 'Del', label: 'Del', key: 'delete' },
  { id: 'Home', label: 'Home', key: 'home' },
  { id: 'End', label: 'End', key: 'end' },
  { id: 'PgUp', label: 'PgUp', key: 'pageup' },
  { id: 'PgDn', label: 'PgDn', key: 'pagedown' },
  { id: 'F5', label: 'F5', key: 'f5', action: 'Refresh' },

  // Shortcut caps. Labelling rule: a chord whose SHAPE is the same on both
  // hosts keeps its chord label (Ctrl+T reads as ⌘T on a Mac — one habit,
  // two spellings); a chord that changes shape entirely between platforms
  // (⌘⇧4 vs Win+⇧+S) gets a word instead, because no chord label for it
  // could ever be learned once and trusted twice.
  { id: 'Ctrl+F', label: 'Ctrl+F', key: 'f', mods: ['ctrl'], macLabel: '⌘F', macMods: ['cmd'], action: 'Find' },
  { id: 'Ctrl+T', label: 'Ctrl+T', key: 't', mods: ['ctrl'], macLabel: '⌘T', macMods: ['cmd'], action: 'New tab' },
  { id: 'Ctrl+W', label: 'Ctrl+W', key: 'w', mods: ['ctrl'], macLabel: '⌘W', macMods: ['cmd'], action: 'Close tab or window' },
  { id: 'Ctrl+S', label: 'Ctrl+S', key: 's', mods: ['ctrl'], macLabel: '⌘S', macMods: ['cmd'], action: 'Save' },
  // Win alone opens Start's search box; ⌘Space opens Spotlight — the same
  // "type an app's name" gesture on both, and the fastest way to launch
  // anything from a phone.
  { id: 'Search', label: 'Search', key: 'win', macKey: 'space', macMods: ['cmd'], action: 'Search the computer' },
  // Region screenshot: Win+Shift+S opens Snip & Sketch, ⌘⇧4 gives the
  // crosshair. Both then want a drag, which touch/trackpad mode provides.
  { id: 'Snip', label: 'Snip', key: 's', mods: ['win', 'shift'], macKey: '4', macMods: ['cmd', 'shift'], action: 'Screenshot a region' },
  // Whole-screen screenshot. Windows gets Win+PrintScreen rather than bare
  // PrintScreen: it saves a file to Pictures\Screenshots and dims the screen,
  // where bare PrintScreen only fills a clipboard the phone cannot see into.
  // ⌘⇧3 writes to the Desktop — a file on both, visible feedback on both.
  { id: 'Shot', label: 'Shot', key: 'printscreen', mods: ['win'], macKey: '3', macMods: ['cmd', 'shift'], action: 'Screenshot the whole screen' },
  { id: 'Quit', label: 'Quit', key: 'f4', mods: ['alt'], macKey: 'q', macMods: ['cmd'], action: 'Quit the app in front' },
  // Lock needs LITERAL Control on a Mac (⌃⌘Q); plain 'ctrl' would be
  // remapped to Command by the host's default BELAY_MAC_CTRL, so the spec
  // says 'rawctrl', which always means Control (server/src/keys.ts).
  { id: 'Lock', label: 'Lock', key: 'l', mods: ['win'], macKey: 'q', macMods: ['rawctrl', 'cmd'], action: 'Lock the computer' },

  // Desktop/space navigation — the visible twin of the three-finger swipe on
  // the stage (docs/DESIGN.md §11: nothing may live behind a gesture alone).
  // Word labels throughout: the chords change shape entirely between hosts
  // (Ctrl+← vs Win+Ctrl+←, ⌃↑ vs Win+Tab). Spaces need LITERAL Control on a
  // Mac, exactly like Lock — plain 'ctrl' would be remapped to Command by the
  // host's default BELAY_MAC_CTRL, and ⌘← is "line start", not "next space".
  { id: 'DeskPrev', label: 'Desk ←', key: 'left', mods: ['win', 'ctrl'], macMods: ['rawctrl'], action: 'Previous desktop' },
  { id: 'DeskNext', label: 'Desk →', key: 'right', mods: ['win', 'ctrl'], macMods: ['rawctrl'], action: 'Next desktop' },
  { id: 'Overview', label: 'Views', key: 'tab', mods: ['win'], macKey: 'up', macMods: ['rawctrl'], action: 'See every window and desktop' },

  // 3-finger down: App Exposé on Mac (shows windows of current app), unbound
  // on Windows (Win+D is destructive toggle). Triggered by 3-finger swipe down.
  { id: 'AppExpose', label: 'App Windows', macKey: 'down', macMods: ['rawctrl'], action: 'Show windows of current app' },

  // 2-finger edge gesture: Notification Center / Action Center. Triggered by
  // 2-finger swipe down from top edge. Windows only — macOS has no default
  // hotkey for NC (user must configure one in System Settings).
  { id: 'NotifyCenter', label: 'Notify', key: 'a', mods: ['win'], action: 'Open action center' },
]);

/** Modifiers to send for a key, honouring the macOS variant when relevant. */
export const modsFor = (spec: KeySpec, mac: boolean): string[] => [
  ...((mac && spec.macMods ? spec.macMods : spec.mods) ?? []),
];

export const labelFor = (spec: KeySpec, mac: boolean): string =>
  mac && spec.macLabel ? spec.macLabel : spec.label;

/** The key name to send, honouring a chord that moves keys across platforms. */
export const keyFor = (spec: KeySpec, mac: boolean): string =>
  mac && spec.macKey ? spec.macKey : spec.key;

// --- macOS permission copy --------------------------------------------------

/**
 * The single most important sentence in this screen. Users grant Screen
 * Recording to "node", see it ticked, and cannot understand why the picture is
 * still black — the grant belongs to the process that spawned the server.
 */
export const LAUNCHER_NOTE =
  'macOS grants these permissions to the app that launched the server — Terminal, iTerm, ghostty or VS Code — never to node itself. That is why the toggle can look correct while nothing works, until you quit and reopen that app.';

export const MAC_STEPS: readonly string[] = Object.freeze([
  'Open System Settings → Privacy & Security on the Mac.',
  'Enable the app that launched the host agent under Screen Recording, and again under Accessibility.',
  'Fully quit that app — ⌘Q, not just closing the window — then reopen it.',
  'Start the host agent again and tap Recheck.',
]);

/** Host errors that smell like a macOS privacy prompt rather than a real fault. */
export const PERMISSION_PATTERN = /permission|not authoriz|screen ?record|accessibility|denied|tcc/i;

// --- pure helpers -----------------------------------------------------------

export const messageOf = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'unknown error';
};

export const numberOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const clamp01 = (value: number): number => clamp(value, 0, 1);

/** Largest box with the given aspect ratio that fits inside `box`. */
export const fitBox = (box: Size, aspect: number): Size => {
  if (box.w <= 0 || box.h <= 0 || aspect <= 0) return EMPTY_SIZE;
  const h = Math.min(box.h, box.w / aspect);
  return { w: h * aspect, h };
};

// --- true-resolution (virtual display) selection ----------------------------
//
// The NEW axis, orthogonal to the Smooth/Balanced/Sharp quality presets above.
// Quality decides how many pixels are ENCODED (the downscale width); resolution
// decides what the host actually RENDERS. "Physical" is today's behavior and
// the fallback — capture the real monitor and letterbox to its aspect. The
// other options ask the host to spin up a driver-backed virtual display at an
// exact size, so the desktop arrives already the phone's shape: no letterbox.

/** A resolution the phone can ask the host to render at. */
export interface ResolutionOption {
  /** Stable id, also the SegmentedControl value and testID suffix. */
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /**
   * The virtual-display size to request, or `null` for the physical monitor
   * (today's downscale path). `null` is the only value that works on every
   * host; the rest need the host to advertise `available`.
   */
  readonly size: Size | null;
}

/** Refresh the phone asks for. The host clamps 24..240; 60 suits every client. */
export const VIRTUAL_REFRESH_HZ = 60;

/** The id of the always-present physical/fallback option. */
export const PHYSICAL_RESOLUTION_ID = 'physical';

export const PHYSICAL_RESOLUTION: ResolutionOption = Object.freeze({
  id: PHYSICAL_RESOLUTION_ID,
  label: 'Physical screen',
  hint: 'Mirror the real monitor and fit it to your phone. Works on every host; the picture is letterboxed when the shapes differ.',
  size: null,
});

/** Fixed true-resolution choices, in menu order. "Match my phone" is prepended
 *  at runtime because it depends on the device's own logical size. */
export const RESOLUTION_PRESETS: readonly ResolutionOption[] = Object.freeze([
  { id: '1280x800', label: '1280 × 800', hint: 'A compact 16:10 desktop — sharp text without a lot of pixels to send.', size: { w: 1280, h: 800 } },
  { id: '1920x1200', label: '1920 × 1200', hint: 'A full 16:10 desktop. More room for windows; more pixels over the link.', size: { w: 1920, h: 1200 } },
]);

/** Nearest even integer — the encoder rejects odd dimensions, and the host
 *  clamps anyway, but sending a valid size keeps the phone's aspect math and
 *  the host's in agreement. */
export const toEven = (n: number): number => 2 * Math.round(n / 2);

/**
 * The "Match my phone" option for a device of the given logical size, or null
 * when the size is not yet known (dimensions are 0 before first layout). The
 * host renders the desktop at exactly the phone's shape, so it fills the screen
 * edge to edge with nothing cropped and nothing letterboxed.
 */
export const matchDeviceResolution = (device: Size): ResolutionOption | null => {
  if (device.w <= 0 || device.h <= 0) return null;
  const size: Size = { w: toEven(device.w), h: toEven(device.h) };
  return {
    id: 'match',
    label: 'Match my phone',
    hint: `Render the desktop at ${size.w} × ${size.h} — your screen's exact shape, edge to edge with no letterbox.`,
    size,
  };
};

/**
 * The resolution menu for this device: physical first (always), then "Match my
 * phone" when the device size is known, then the fixed presets.
 */
export const resolutionOptions = (device: Size): ResolutionOption[] => {
  const match = matchDeviceResolution(device);
  return [PHYSICAL_RESOLUTION, ...(match ? [match] : []), ...RESOLUTION_PRESETS];
};

/** The virtual-display request an option maps to, or `null` for the physical
 *  screen. `null` is the wire value that tells the host to tear any virtual
 *  display down and fall back — see `buildConfigMessage` in stream.ts. */
export interface VirtualRequest {
  readonly width: number;
  readonly height: number;
  readonly refreshHz: number;
}

export const virtualRequestFor = (option: ResolutionOption): VirtualRequest | null =>
  option.size
    ? { width: toEven(option.size.w), height: toEven(option.size.h), refreshHz: VIRTUAL_REFRESH_HZ }
    : null;

/** The `/ws/screen` `config` control message. One writer for the host contract,
 *  so the socket code and the tests assert against the exact wire bytes. */
export interface ConfigMessage {
  readonly type: 'config';
  readonly w: number;
  readonly q: number;
  readonly fps: number;
  readonly screen?: number;
  /** The true-resolution request, or explicit `null` for the physical screen.
   *  The phone is authoritative about the mode, so this is ALWAYS present — the
   *  host reads `null` as "tear the virtual display down and downscale". */
  readonly virtualDisplay: VirtualRequest | null;
}

/**
 * Shape the live retune message. `screen` is omitted (not null) when absent —
 * JSON.stringify drops undefined keys and the host treats a missing field as
 * "keep current", exactly as the monitor picker has always relied on.
 * `virtualDisplay` is different: it is always sent, because the phone drives
 * the resolution mode and a missing field would strand a stale virtual display.
 */
export const buildConfigMessage = (
  quality: QualityPreset,
  screen: number | undefined,
  virtual: VirtualRequest | null,
): ConfigMessage => ({
  type: 'config',
  w: quality.w,
  q: quality.q,
  fps: quality.fps,
  ...(screen === undefined ? {} : { screen }),
  virtualDisplay: virtual,
});

/** Resolve a saved id against the live menu, falling back to physical when the
 *  option no longer exists (the device size changed, or the host stopped
 *  advertising the feature). One value in, always a valid option out. */
export const findResolution = (id: string, options: readonly ResolutionOption[]): ResolutionOption =>
  options.find((o) => o.id === id) ?? PHYSICAL_RESOLUTION;
