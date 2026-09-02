// Idempotency cache for POST /pair.
//
// Pairing is a non-idempotent mutation: consumeCode() burns the single-use code
// and addDevice() mints a token BEFORE the response is written. On a flaky or
// far-away link the reply can be lost *after* that mutation landed — the phone
// times out, the token never arrives, and re-entering the same (now-burned) code
// is answered 400, bricking first-run.
//
// This cache makes the mutation replayable. But — the security lesson from the
// board review — the pairing code is displayed ON THE PC SCREEN, so it is NOT a
// secret only the pairing device holds: anyone who glances at the screen could
// resubmit it within the window and be handed the token minted for the real
// device. So the replay is bound to the REQUESTER'S SOURCE IDENTITY, not to the
// code alone. A retry recovers the token only when it comes from the same source
// that consumed the code; a different device gets the normal 400.
//
// Pure module — no HTTP, no timers of its own. The clock is injected, so
// pair-replay.test.ts drives expiry on a fake one.

/** Mirrors the pairing code's own 5-minute lifetime. */
export const PAIR_REPLAY_TTL_MS = 5 * 60 * 1000;

/** The replayable body of a successful /pair response. */
export interface PairReplayResult {
  readonly token: string;
  readonly name: string;
  readonly via?: string;
}

export interface PairReplayCache {
  /** Record the token issued for `code` to `sourceId`, so that same source can
   *  replay it. */
  remember(code: string, sourceId: string, result: PairReplayResult): void;
  /** The token previously issued for `code`, but ONLY to the same `sourceId`
   *  that consumed it, and only within the window. Otherwise null. */
  lookup(code: string, sourceId: string): PairReplayResult | null;
}

export interface PairReplayOptions {
  readonly ttlMs?: number;
  /** Injected clock; defaults to Date.now. */
  readonly now?: () => number;
}

interface Entry {
  readonly result: PairReplayResult;
  readonly sourceId: string;
  readonly expires: number;
}

export function createPairReplayCache(options: PairReplayOptions = {}): PairReplayCache {
  const ttlMs = options.ttlMs ?? PAIR_REPLAY_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const prune = (at: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expires <= at) entries.delete(key);
    }
  };

  return {
    remember(code, sourceId, result): void {
      const at = now();
      prune(at);
      // An empty source id (unknown remote address) is never remembered — it
      // could not be safely matched on lookup, so it must not enable replay.
      if (!code || !sourceId) return;
      entries.set(code, { result, sourceId, expires: at + ttlMs });
    },

    lookup(code, sourceId): PairReplayResult | null {
      const at = now();
      prune(at);
      if (!code || !sourceId) return null;
      const entry = entries.get(code);
      if (!entry) return null;
      if (entry.expires <= at) { entries.delete(code); return null; }
      // The binding: only the source that consumed the code may replay it.
      if (entry.sourceId !== sourceId) return null;
      return entry.result;
    },
  };
}
