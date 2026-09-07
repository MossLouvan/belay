export const EXIT_HOLD_MS = 1200;
export const EXIT_CHORD = 16 | 32;
interface ExitState {
  readonly since: number | null;
  readonly fired: boolean;
  readonly exit: boolean;
  readonly progress: number;
  readonly suppress: boolean;
  readonly chordLatched: boolean;
}
export const emptyExit = (): ExitState => ({ since: null, fired: false, exit: false, progress: 0, suppress: false, chordLatched: false });

/** Both menu buttons are available even when the OS reserves Guide/PS. */
export function exitHold(previous: ExitState, buttons: number, guide: boolean, touch: boolean, now: number): ExitState {
  if (!Number.isFinite(now)) return emptyExit();
  const chord = (buttons & EXIT_CHORD) === EXIT_CHORD;
  const chordLatched = chord || (previous.chordLatched && (buttons & EXIT_CHORD) !== 0);
  const pressed = chord || guide || touch;
  if (!pressed) return { ...emptyExit(), chordLatched, suppress: chordLatched };
  const since = previous.since !== null && now >= previous.since ? previous.since : now;
  const progress = Math.min(1, Math.max(0, (now - since) / EXIT_HOLD_MS));
  const exit = !previous.fired && progress >= 1;
  return { since, fired: previous.fired || exit, exit, progress, suppress: true, chordLatched };
}
