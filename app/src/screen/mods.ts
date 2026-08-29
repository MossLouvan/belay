// Sticky modifier latching for the on-screen key bar.
//
// The phone has no physical Ctrl/Alt/Shift/Win to hold down, so the key bar's
// modifier caps latch instead: tap once and the modifier rides along with the
// NEXT key (then clears), tap twice quickly and it locks until tapped again.
// A plain stage tap also clears anything latched — reaching for the mouse is
// how you abandon a half-typed shortcut on a real keyboard too.
//
// Pure functions only: the reducer is exercised directly by mods.test.mjs
// under Node's type stripping, so nothing here may import React or JSX.

export type StickyMod = 'ctrl' | 'alt' | 'shift' | 'win';
export type ModPhase = 'off' | 'latched' | 'locked';

/** Display order — also the order modifiers are sent to the host. */
export const STICKY_MODS: readonly StickyMod[] = Object.freeze(['ctrl', 'alt', 'shift', 'win']);

/** Two taps within this window mean "lock", matching typical double-tap feel. */
export const DOUBLE_TAP_MS = 350;

export interface ModsState {
  readonly phases: Readonly<Record<StickyMod, ModPhase>>;
  /** The previous tap, so the next one can be classified as a double. */
  readonly lastTap: { readonly mod: StickyMod; readonly at: number } | null;
}

export const IDLE_MODS: ModsState = Object.freeze({
  phases: Object.freeze({ ctrl: 'off', alt: 'off', shift: 'off', win: 'off' }),
  lastTap: null,
});

const withPhase = (state: ModsState, mod: StickyMod, phase: ModPhase, at: number): ModsState => ({
  phases: { ...state.phases, [mod]: phase },
  lastTap: { mod, at },
});

/**
 * One tap on a modifier cap.
 *
 *   off      -> latched   (armed for the next key)
 *   latched  -> locked    if this is the second tap of a double, else off
 *   locked   -> off
 */
export function tapMod(state: ModsState, mod: StickyMod, now: number): ModsState {
  const phase = state.phases[mod];
  const last = state.lastTap;
  const isDouble = last !== null && last.mod === mod && now - last.at >= 0 && now - last.at <= DOUBLE_TAP_MS;
  const next: ModPhase = phase === 'off' ? 'latched' : phase === 'latched' && isDouble ? 'locked' : 'off';
  return withPhase(state, mod, next, now);
}

/**
 * A key was sent or the stage was tapped: one-shot latches are spent, locks
 * survive. Returns the SAME object when nothing was latched, so callers can
 * hand this straight to a state setter without causing pointless re-renders.
 */
export function releaseLatched(state: ModsState): ModsState {
  if (!STICKY_MODS.some((mod) => state.phases[mod] === 'latched') && state.lastTap === null) return state;
  const phases = { ...state.phases };
  for (const mod of STICKY_MODS) {
    if (phases[mod] === 'latched') phases[mod] = 'off';
  }
  return { phases, lastTap: null };
}

/** Modifiers currently in force (latched or locked), in send order. */
export function activeMods(state: ModsState): StickyMod[] {
  return STICKY_MODS.filter((mod) => state.phases[mod] !== 'off');
}

export function anyActive(state: ModsState): boolean {
  return STICKY_MODS.some((mod) => state.phases[mod] !== 'off');
}

/**
 * Wire names the host expects for these modifiers. The Windows host understands
 * 'win' directly; on macOS the same cap means Command, which the host names
 * 'cmd' (its DARWIN_MOD_VK maps both, but 'cmd' says what we mean).
 */
export function modNamesForHost(mods: readonly StickyMod[], mac: boolean): string[] {
  return mods.map((mod) => (mod === 'win' && mac ? 'cmd' : mod));
}
