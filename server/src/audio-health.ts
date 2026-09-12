// Why host audio is not playing — turned into something the phone can SAY.
//
// Before this module every audio failure reached the phone as one word:
// "unavailable". Four completely different faults hid behind it, and they have
// four completely different fixes:
//
//   * the host SERVER is too old to have an audio surface at all  → update it;
//   * the native HELPER has no audio verbs (built before they existed) → rebuild;
//   * the OS refused the capture permission → grant it, in a named pane;
//   * capture started and then delivered nothing → the endpoint/stream died.
//
// Everything here is pure: a string (or a clock reading) in, a typed verdict
// out. That is what makes "the phone says the true reason" a tested property
// rather than a hope — server/test/audio-health.test.ts asserts every branch.

/** What is actually wrong, in the order a user would act on it. */
export type AudioFailureKind =
  | 'helper-missing' // the helper process is not running at all
  | 'unsupported-helper' // helper runs but has no audiostart verb
  | 'permission' // the OS refused the capture grant
  | 'no-device' // no render endpoint / no display to anchor capture
  | 'capture-stalled' // started, then stopped delivering frames
  | 'unknown';

export interface AudioFailure {
  readonly kind: AudioFailureKind;
  /** One sentence naming the fault. Safe to show verbatim. */
  readonly message: string;
  /** One sentence naming the fix. Empty when we genuinely do not know one. */
  readonly hint: string;
  /** The raw text we classified, kept for logs — never shown as the headline. */
  readonly detail: string;
}

/** Host platform as `process.platform` reports it; only the advice differs. */
export type AudioPlatform = 'darwin' | 'win32' | string;

const PERMISSION_HINT: Readonly<Record<string, string>> = Object.freeze({
  darwin:
    'On the Mac, open System Settings → Privacy & Security → Screen & System Audio Recording '
    + 'and tick the app that launched Belay (usually Terminal), then restart Belay.',
  win32: 'On the PC, allow Belay to use the audio endpoint, then restart Belay.',
});

const NO_DEVICE_HINT: Readonly<Record<string, string>> = Object.freeze({
  darwin: 'Connect or wake a display — macOS anchors system-audio capture to one.',
  win32:
    'Windows needs a playback device to tap: plug in speakers or headphones, or enable the '
    + '"High Definition Audio Device" output, then try again.',
});

function hintFor(table: Readonly<Record<string, string>>, platform: AudioPlatform, fallback: string): string {
  return table[platform] ?? fallback;
}

/**
 * Classify a raw failure string from the native helper (or from our own bridge)
 * into something worth showing a human. Never throws; an unrecognised string
 * becomes `unknown` with the original text as the message, which is still far
 * better than "unavailable".
 */
export function classifyAudioFailure(raw: unknown, platform: AudioPlatform = process.platform): AudioFailure {
  const detail = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  const text = detail.toLowerCase();

  if (!detail) {
    return build('unknown', 'System audio failed for an unreported reason.', '', detail);
  }
  if (/unknown command|not built into this helper|bad ?command/.test(text)) {
    return build(
      'unsupported-helper',
      "This computer's Belay helper was built before system-audio capture existed.",
      'Run `npm run build:native` in the Belay server folder on that computer, then restart Belay.',
      detail,
    );
  }
  if (/helper (is )?(not ready|not available|unavailable|exited|crashed)|native helper/.test(text)) {
    return build(
      'helper-missing',
      "This computer's Belay helper is not running, so nothing can capture audio.",
      'Restart Belay on that computer.',
      detail,
    );
  }
  if (/permission|not authoriz|not authoris|tcc|screen (&|and) system audio|screen recording|access is denied|denied/.test(text)) {
    return build(
      'permission',
      'The operating system refused Belay permission to record system audio.',
      hintFor(PERMISSION_HINT, platform, 'Grant Belay permission to record system audio, then restart it.'),
      detail,
    );
  }
  if (/no default render endpoint|no shareable display|no audio endpoint|no render device|0x88890008/.test(text)) {
    return build(
      'no-device',
      'This computer has no active audio output device to tap.',
      hintFor(NO_DEVICE_HINT, platform, 'Connect a playback device and try again.'),
      detail,
    );
  }
  return build('unknown', detail, '', detail);
}

/** The failure for "the helper is capturing, but no audio is reaching us". */
export function stalledCaptureFailure(stopReason: string | undefined, platform: AudioPlatform = process.platform): AudioFailure {
  if (stopReason && stopReason.trim()) {
    const classified = classifyAudioFailure(stopReason, platform);
    // A stop reason we recognise (permission, no device) is the REAL fault and
    // keeps its own advice; only an unrecognised one becomes a bare stall.
    if (classified.kind !== 'unknown') return classified;
    return build('capture-stalled', `System audio capture stopped: ${stopReason.trim()}`, '', stopReason);
  }
  return build(
    'capture-stalled',
    'Audio capture started but no sound is arriving from this computer.',
    'Check that the computer is playing to its normal speakers, then toggle host audio off and on.',
    '',
  );
}

/** No frame for this long, while capture is supposed to be running, is a fault.
 *  Both helpers emit a 20 ms frame continuously — including pure silence — so a
 *  multi-second gap is never "nothing is playing". */
export const AUDIO_STALL_TIMEOUT_MS = 4000;

/**
 * Has the stream stalled? `lastFrameAt` is the last time a frame reached the
 * socket, or the moment capture was acquired when none ever has.
 */
export function audioStreamStalled(now: number, lastFrameAt: number, timeoutMs = AUDIO_STALL_TIMEOUT_MS): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(lastFrameAt)) return false;
  return now - lastFrameAt >= timeoutMs;
}

function build(kind: AudioFailureKind, message: string, hint: string, detail: string): AudioFailure {
  return { kind, message, hint, detail };
}
