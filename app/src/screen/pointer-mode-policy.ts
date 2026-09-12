// What one finger does, per orientation — the rule behind "turning the phone
// sideways should not put me back in tap-to-click".
//
// Portrait and landscape are two different machines to hold. Upright the phone
// is a picture you poke: Touch (tap the desktop where you want to click) is the
// right default. Sideways it is a laptop: the founder's verdict was blunt —
// "when I pull it to the side I don't want it to automatically go into the
// tap-touch controls, I want it to default to pad controls". A relative
// trackpad is what a two-hand landscape grip can actually aim with, because the
// thumb never has to reach the far corner of a 6" picture.
//
// The subtlety is that a default must not become an override. If he DELIBERATELY
// picks Touch while sideways, rotating away and back must bring Touch back — the
// app has to remember the choice rather than re-imposing the default every time
// the accelerometer moves. So the choice is remembered PER ORIENTATION: each
// orientation keeps the last mode explicitly chosen while in it, and falls back
// to that orientation's default until one has been chosen. Portrait's choice
// never leaks into landscape and vice versa, which is exactly what "I set this
// up how I like it, in both grips" means.
//
// Pure module — no React, no react-native — so node --test drives it directly
// and use-dock-state.ts is left holding nothing but useState.

import type { PointerMode } from './viewport';

/** Upright the phone is a picture you poke. */
export const PORTRAIT_DEFAULT_MODE: PointerMode = 'touch';

/** Sideways the phone is a laptop: a relative trackpad, not tap-to-click. */
export const LANDSCAPE_DEFAULT_MODE: PointerMode = 'trackpad';

/**
 * The modes explicitly chosen in each orientation. `null` means "never chosen
 * here" — the orientation's default still stands and may change under us.
 */
export interface ModeChoices {
  readonly portrait: PointerMode | null;
  readonly landscape: PointerMode | null;
}

/** Nothing chosen yet, in either grip. */
export const NO_MODE_CHOICES: ModeChoices = Object.freeze({ portrait: null, landscape: null });

/** The mode an orientation starts in before the user has said otherwise. */
export const defaultModeFor = (landscape: boolean): PointerMode =>
  landscape ? LANDSCAPE_DEFAULT_MODE : PORTRAIT_DEFAULT_MODE;

/**
 * The mode in force right now: what was explicitly chosen in this orientation,
 * or that orientation's default. Rotating therefore changes the mode only when
 * the new orientation has no choice of its own to honour.
 */
export const resolveMode = (choices: ModeChoices, landscape: boolean): PointerMode =>
  (landscape ? choices.landscape : choices.portrait) ?? defaultModeFor(landscape);

/**
 * Record a deliberate pick against the orientation it was made in. Returns a
 * NEW record — the caller's copy is never mutated — and returns the same record
 * untouched when nothing would change, so React can skip the re-render.
 */
export function rememberMode(choices: ModeChoices, landscape: boolean, mode: PointerMode): ModeChoices {
  if (resolveMode(choices, landscape) === mode && (landscape ? choices.landscape : choices.portrait) === mode) {
    return choices;
  }
  return landscape ? { ...choices, landscape: mode } : { ...choices, portrait: mode };
}
