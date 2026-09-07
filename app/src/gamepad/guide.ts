interface GuideState { readonly since: number | null; readonly fired: boolean; readonly exit: boolean }
export const emptyGuide = (): GuideState => ({ since: null, fired: false, exit: false });
/** Guide has no wire bit. A local hold exits once and must be released to rearm. */
export function guideHold(previous: GuideState, pressed: unknown, now: number): GuideState {
  if (pressed !== true || !Number.isFinite(now)) return emptyGuide();
  const since = previous.since ?? now;
  const exit = !previous.fired && now - since >= 1000;
  return { since, fired: previous.fired || exit, exit };
}
