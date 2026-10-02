// Newest-wins scheduling for the JPEG stream.
//
// WebSocket messages arrive as separate JS tasks. When the JS thread stalls
// (a long render, a gesture burst) several frames queue up, and handling
// each one in order means base64-encoding ~100 KB payloads the user will
// never see. Instead every payload is parked in one slot and a single
// animation-frame callback handles whatever is newest when it fires; stale
// payloads are overwritten before they cost anything.

const defaultSchedule = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(cb); return; }
  setTimeout(cb, 0);
};

/**
 * Returns an `offer(payload)` that handles only the newest payload offered
 * before the next scheduled tick. `schedule` is injected for tests.
 */
export function newestWins<T>(
  handle: (payload: T) => void,
  schedule: (cb: () => void) => void = defaultSchedule,
): (payload: T) => void {
  let latest: T | undefined;
  let armed = false;
  return (payload: T): void => {
    latest = payload;
    if (armed) return;
    armed = true;
    schedule(() => {
      armed = false;
      const next = latest;
      latest = undefined;
      if (next !== undefined) handle(next);
    });
  };
}
