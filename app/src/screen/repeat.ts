// Held-key auto-repeat: the "hold Backspace and it keeps deleting" behaviour
// every physical keyboard has.
//
// A desktop keyboard fires once on press, waits out a delay so a deliberate
// single tap never repeats, then repeats at a steady rate until release. The
// same shape works here with one extra constraint: every repeat is a network
// round trip to the host, so the loop is SELF-SCHEDULING rather than an
// interval. The next repeat is queued only once the previous send has settled,
// which means a slow Tailscale hop paces itself down instead of piling up a
// backlog of deletes that all land after the finger lifts.
//
// Pure module — no React, no timers of its own. The clock is injected, so
// repeat.test.mjs drives the whole thing on a fake one.

export const REPEAT = Object.freeze({
  /**
   * Hold time before the first repeat. Long enough that a normal tap (and a
   * slightly slow one) never doubles, short enough to feel immediate.
   */
  delayMs: 400,
  /**
   * Floor between repeats. An upper bound of ~18 keys/second — quick enough to
   * clear a line, slow enough that a laggy link is not sending faster than the
   * host can act.
   */
  intervalMs: 55,
});

/** Injected timer pair, so tests never wait on a real clock. */
export interface RepeatClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RepeatOptions {
  readonly delayMs?: number;
  readonly intervalMs?: number;
}

export interface Repeater {
  /** Fires `send` once immediately, then repeats until `stop`. */
  start(): void;
  /** Cancels the pending repeat. Safe to call when not running. */
  stop(): void;
  readonly running: boolean;
}

/**
 * `send` is called once per keypress — the initial press included. Returning a
 * promise opts into back-pressure: the next repeat waits for it to settle
 * (resolved or rejected; a dropped key should not stall the hold).
 */
export function createRepeater(
  send: () => unknown,
  clock: RepeatClock,
  options: RepeatOptions = {},
): Repeater {
  const delayMs = options.delayMs ?? REPEAT.delayMs;
  const intervalMs = options.intervalMs ?? REPEAT.intervalMs;

  let timer: unknown = null;
  let running = false;
  // Bumped on every start and stop. An in-flight send that settles after the
  // finger lifts checks this and declines to schedule another repeat — the
  // difference between a clean release and a key that keeps deleting.
  let generation = 0;

  const schedule = (mine: number, ms: number): void => {
    if (!running || mine !== generation) return;
    timer = clock.setTimeout(() => tick(mine), ms);
  };

  const tick = (mine: number): void => {
    timer = null;
    if (!running || mine !== generation) return;
    const result = send();
    if (isThenable(result)) {
      result.then(
        () => schedule(mine, intervalMs),
        () => schedule(mine, intervalMs),
      );
    } else {
      schedule(mine, intervalMs);
    }
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      generation += 1;
      const mine = generation;
      send();
      schedule(mine, delayMs);
    },

    stop(): void {
      if (!running) return;
      running = false;
      generation += 1;
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
    },

    get running(): boolean {
      return running;
    },
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
