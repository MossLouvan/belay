// "Audio unavailable" was one word covering four different computers.
//
// A host can fail to give us sound for reasons the user can act on, and they
// are not interchangeable:
//
//   * its Belay SERVER is older than the audio feature      → update Belay there
//   * its native HELPER has no audio verbs                  → rebuild the helper
//   * the OS refused the recording permission               → grant it
//   * it has no audio output device to tap                  → plug one in
//
// The host tells us which, by HTTP status and body, on GET /audio/status: 200
// means it can, 501 carries a classified reason and a fix, and a 404 means the
// route does not exist at all — which is itself the answer (that server predates
// system audio). This module is the pure translation of that probe into
// something the Screen menu can print. No fetch, no React: all of it testable.

/** What the probe learned, in the host's own words where it had any. */
export interface AudioProbe {
  /** HTTP status from GET /audio/status. 0 means the request never landed. */
  readonly status: number;
  /** Body fields the host sends on a 501 (audio-health.ts on the server). */
  readonly error?: string;
  readonly kind?: string;
  readonly hint?: string;
}

export interface AudioSupport {
  readonly supported: boolean;
  /** Machine-readable fault, so short UI (the dock) can pick its own wording.
   *  '' when supported; mirrors the server's AudioFailureKind otherwise, plus
   *  'host-too-old' and 'unreachable', which only the phone can conclude. */
  readonly kind: string;
  /** Headline, shown where "unavailable" used to be. */
  readonly message: string;
  /** The fix, shown under the headline. Empty when there is nothing useful. */
  readonly hint: string;
}

const SUPPORTED: AudioSupport = Object.freeze({ supported: true, kind: '', message: '', hint: '' });

/** A host old enough to have no /audio/* surface at all. The single most likely
 *  cause of "audio is unavailable" on a machine that has not been updated. */
export const HOST_TOO_OLD: AudioSupport = Object.freeze({
  supported: false,
  kind: 'host-too-old',
  message: "This computer's Belay host is too old to stream audio.",
  hint: 'Update Belay on that computer (git pull, then restart it) and try again.',
});

const UNREACHABLE: AudioSupport = Object.freeze({
  supported: false,
  kind: 'unreachable',
  message: 'Could not ask this computer whether it can stream audio.',
  hint: 'Check the connection to it, then toggle host audio off and on.',
});

/**
 * Turn one probe of GET /audio/status into a verdict. Unknown statuses are
 * treated as "we could not tell" rather than as a refusal, because guessing
 * "unavailable" is exactly the confidently-wrong answer this replaces.
 */
export function audioSupportFrom(probe: AudioProbe): AudioSupport {
  if (probe.status === 200) return SUPPORTED;
  if (probe.status === 404) return HOST_TOO_OLD;
  if (probe.status === 501) {
    const message = probe.error?.trim() || 'This computer cannot capture its system audio.';
    return { supported: false, kind: probe.kind?.trim() || 'unknown', message, hint: probe.hint?.trim() ?? '' };
  }
  // 401/403 are a pairing problem, not an audio problem — and every other code
  // is a host we could not question. Both are "unknown", never "unsupported".
  return UNREACHABLE;
}

/** The short label for the dock, where only a few words fit. Never lies: a
 *  host that cannot do audio says so differently from one that is connecting. */
export function audioDockLabel(
  audioOn: boolean,
  phase: 'off' | 'connecting' | 'playing' | 'error',
  kind?: string,
): string {
  if (!audioOn) return 'Audio off';
  if (phase === 'playing') return 'Audio on';
  if (phase === 'connecting') return 'Connecting audio';
  if (phase !== 'error') return 'Connecting audio';
  if (kind === 'host-too-old') return 'Host needs update';
  if (kind === 'unsupported-helper') return 'Helper needs rebuild';
  if (kind === 'permission') return 'Audio needs permission';
  if (kind === 'no-device') return 'No audio device';
  return 'Audio error';
}
