// The hold-to-talk state machine and its failure vocabulary, pure and
// renderer-free so `mic.test.mjs` can drive every transition in plain Node —
// same contract as model.ts and attention.ts.
//
// The machine exists because voice input is all races: the recognizer's
// events (start, result, error, end) arrive on their own schedule while the
// user's finger presses and releases on another. Folding both streams through
// one reducer means "released before recognition started", "error then end",
// and "final result after release" are decided in one tested place instead of
// scattered through event handlers.

/**
 * Where one utterance is in its life:
 *
 *   idle ──press──▶ starting ──started──▶ listening ──release──▶ stopping ──ended──▶ idle
 *
 * `starting` covers the permission prompts and the recognizer spin-up;
 * `stopping` is the tail after release while iOS settles on the final text.
 * Errors and too-short holds drop straight back to idle from anywhere.
 */
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'stopping';

export interface VoiceMachine {
  readonly phase: VoicePhase;
  /** Live text of the current utterance — interim until iOS finalizes it. */
  readonly transcript: string;
  /** Whether any recognition result has arrived this utterance. */
  readonly heard: boolean;
  /**
   * Whether an error was already surfaced this utterance. iOS sends `error`
   * *and then* `end`; without this flag the end handler would pile a
   * "no speech" complaint on top of the real one.
   */
  readonly failed: boolean;
}

export const VOICE_IDLE: VoiceMachine = Object.freeze({
  phase: 'idle',
  transcript: '',
  heard: false,
  failed: false,
});

export type VoiceAction =
  | { readonly type: 'press' }
  | { readonly type: 'started' }
  | { readonly type: 'result'; readonly transcript: string }
  | { readonly type: 'release' }
  /** A mis-tap or a deliberate abort: discard the utterance entirely. */
  | { readonly type: 'cancel' }
  | { readonly type: 'error' }
  | { readonly type: 'ended' };

/** Folds one finger or recognizer event into the machine. */
export function reduceVoice(state: VoiceMachine, action: VoiceAction): VoiceMachine {
  switch (action.type) {
    case 'press':
      // A press while anything is in flight is the same finger bouncing —
      // starting a second recognition over the first would corrupt both.
      return state.phase === 'idle' ? { ...VOICE_IDLE, phase: 'starting' } : state;
    case 'started':
      return state.phase === 'starting' ? { ...state, phase: 'listening' } : state;
    case 'result':
      // Results can land in any live phase — the final one usually arrives
      // *after* release, while the machine is already stopping.
      if (state.phase === 'idle') return state;
      return { ...state, transcript: action.transcript, heard: true };
    case 'release':
      return state.phase === 'starting' || state.phase === 'listening'
        ? { ...state, phase: 'stopping' }
        : state;
    case 'cancel':
      return VOICE_IDLE;
    case 'error':
      // The recognizer may still emit `end` after an error; `failed` tells
      // that handler the user has already been told what happened.
      return { ...VOICE_IDLE, failed: true };
    case 'ended':
      // Always a clean slate: the recognizer's `end` follows its `error`, and
      // the `failed` marker must not outlive the utterance it described.
      return VOICE_IDLE;
  }
}

// ---- failure vocabulary -----------------------------------------------------
//
// §11.4: state what was observed, offer a way forward. Every line names the
// thing that happened and what to do about it; none of them blames the user.

export const NO_SPEECH_MESSAGE = 'no speech was heard — hold the button and speak';
export const RECOGNIZER_UNAVAILABLE_MESSAGE =
  'speech recognition is unavailable on this iPhone — check that Siri & Dictation are enabled in Settings';

/**
 * One line for a recognizer error code, or null for the codes that are not
 * news to the user (an abort is something we did on purpose).
 */
export function voiceErrorMessage(code: string, detail?: string): string | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'not-allowed':
      return 'microphone or speech recognition access is off for Deskhandler — allow both in Settings';
    case 'service-not-allowed':
      return RECOGNIZER_UNAVAILABLE_MESSAGE;
    case 'language-not-supported':
      return 'this language has no speech recognizer on this iPhone';
    case 'no-speech':
    case 'speech-timeout':
      return NO_SPEECH_MESSAGE;
    case 'network':
      return 'speech recognition needed the internet and could not reach it — check the connection and try again';
    case 'audio-capture':
      return 'the microphone could not record — another app may be using it';
    case 'interrupted':
      return 'listening was interrupted by another sound session — try again';
    case 'busy':
      return 'the recognizer is busy — try again in a moment';
    default:
      return detail || 'speech recognition failed';
  }
}

// ---- permission branching ---------------------------------------------------

/** The slice of an iOS permission response the branching needs. */
export interface PermissionSnapshot {
  readonly granted: boolean;
  readonly canAskAgain?: boolean;
}

/**
 * Voice needs two separate iOS permissions — the microphone *and* speech
 * recognition — and either can be denied on its own. Returns the one-line
 * problem naming which is off (mic checked first: without it the speech ask
 * never even matters), or null when both are granted. Every non-null return
 * is a Settings problem: iOS only re-asks via the Settings app once denied.
 */
export function permissionProblem(
  mic: PermissionSnapshot | null,
  speech: PermissionSnapshot | null,
): string | null {
  if (!mic?.granted) return 'microphone access is off for Deskhandler — allow it in Settings to talk';
  if (!speech?.granted) return 'speech recognition is off for Deskhandler — allow it in Settings to talk';
  return null;
}
