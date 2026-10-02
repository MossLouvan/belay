// Touch-mode drags, live (#136): press at the start, stream throttled moves
// while the finger travels, release at the end — and release on cancel, so a
// gesture the OS steals never leaves the host's button held. Hosts without
// /input/down (no `inputHold` in /screen/info) get the old atomic /input/drag.
//
// Every send rides one serial chain: the press must land before the first
// move and the release after the last, whatever the network reorders.

export type Point = { readonly x: number; readonly y: number };

export interface DragIO {
  down(p: Point): Promise<unknown>;
  move(p: Point): Promise<unknown>;
  up(p: Point): Promise<unknown>;
  drag(from: Point, to: Point): Promise<unknown>;
  onError(message: string): void;
}

export interface Clock {
  now(): number;
  schedule(fn: () => void, ms: number): void;
}

const realClock: Clock = { now: () => Date.now(), schedule: (fn, ms) => { setTimeout(fn, ms); } };

export function createLiveDrag(io: DragIO, throttleMs: number, clock: Clock = realClock) {
  let phase: 'idle' | 'held' | 'legacy' = 'idle';
  let from: Point = { x: 0, y: 0 };
  let last: Point = from;
  let owed: Point | null = null;
  let scheduled = false;
  let lastMoveAt = -Infinity;
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = (op: () => Promise<unknown>) => {
    chain = chain.then(op).catch((e: unknown) => io.onError(e instanceof Error ? e.message : String(e)));
  };

  const flush = () => {
    scheduled = false;
    const p = owed;
    owed = null;
    if (!p || phase !== 'held') return;
    lastMoveAt = clock.now();
    enqueue(() => io.move(p));
  };

  const release = (p: Point) => {
    phase = 'idle';
    owed = null;
    enqueue(() => io.up(p));
  };

  return {
    start(p: Point, live: boolean) {
      from = last = p;
      phase = live ? 'held' : 'legacy';
      if (live) enqueue(() => io.down(p));
    },
    move(p: Point) {
      last = p;
      if (phase !== 'held') return;
      owed = p;
      if (scheduled) return;
      const wait = throttleMs - (clock.now() - lastMoveAt);
      if (wait <= 0) { flush(); return; }
      scheduled = true;
      clock.schedule(flush, wait);
    },
    end(p: Point) {
      if (phase === 'held') release(p);
      else if (phase === 'legacy') { phase = 'idle'; enqueue(() => io.drag(from, p)); }
    },
    /** The gesture was taken away: let go wherever the finger last was. */
    cancel() {
      if (phase === 'held') release(last);
      phase = 'idle';
    },
  };
}
