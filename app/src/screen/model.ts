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
  maxNotchesPerSend: 8,
  moveThrottleMs: 40,
  scrollThrottleMs: 60,
  friction: 0.93,
  minMomentumPx: 0.4,
  trackpadGain: 0.85,
  /** Frame budget assumed for the momentum decay, in ms. */
  frameMs: 16,
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
}

export const KEYS: readonly KeySpec[] = Object.freeze([
  { id: 'Esc', label: 'Esc', key: 'escape' },
  { id: 'Tab', label: 'Tab', key: 'tab' },
  { id: 'Enter', label: 'Enter', key: 'enter' },
  { id: 'Bksp', label: 'Bksp', key: 'backspace' },
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
  // remapped to Command by the host's default TETHER_MAC_CTRL, so the spec
  // says 'rawctrl', which always means Control (server/src/keys.ts).
  { id: 'Lock', label: 'Lock', key: 'l', mods: ['win'], macKey: 'q', macMods: ['rawctrl', 'cmd'], action: 'Lock the computer' },
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
