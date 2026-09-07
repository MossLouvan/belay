// The hold that leaves Gaming. Two sources share one timer: the small Exit
// button on the phone, and the PS/Guide button on a paired controller (it has
// no host bit, so nothing is lost by claiming it). Start and Back are never
// part of the exit — they always reach the game as ordinary buttons.
export const EXIT_HOLD_MS = 1200;

interface ExitState {
  readonly since: number | null;
  readonly fired: boolean;
  readonly exit: boolean;
  readonly progress: number;
}

export const emptyExit = (): ExitState => ({ since: null, fired: false, exit: false, progress: 0 });

export function exitHold(previous: ExitState, guide: boolean, touch: boolean, now: number): ExitState {
  if (!Number.isFinite(now)) return emptyExit();
  if (!guide && !touch) return emptyExit();
  const since = previous.since !== null && now >= previous.since ? previous.since : now;
  const progress = Math.min(1, Math.max(0, (now - since) / EXIT_HOLD_MS));
  const exit = !previous.fired && progress >= 1;
  return { since, fired: previous.fired || exit, exit, progress };
}
