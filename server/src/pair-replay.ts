// Idempotency cache for POST /pair.
//
// Pairing is a non-idempotent mutation: `consumeCode()` burns the single-use
// code and `addDevice()` mints a device token BEFORE the response is written.
// On a flaky or far-away link the reply can be lost *after* that mutation has
// already landed. The phone's request then times out, so the token never
// reaches it — and because the code is already burned, re-entering the very
// same code (still shown on the PC) is answered with `400 invalid or expired`.
// The result is a permanently bricked first run: the host counts one device,
// stops minting codes, and there is no in-app lever to recover.
//
// This cache makes the mutation replayable. The result of a successful pairing
// is remembered, keyed by the code that produced it, for a short window. An
// identical retry with the same code returns the SAME token instead of a 400,
// so a client that lost the first reply recovers by simply asking again — the
// user can even re-type the code straight off the PC screen.
//
// The code is the retry key on purpose. It is the one value the client already
// holds and can resend unchanged, and it is single-use, so a remembered entry
// can only ever have come from the single device that legitimately consumed it
// — replaying it hands the token back to that same pairing, not to a new one.
//
// Pure module — no HTTP, no timers of its own. The clock is injected, so
// pair-replay.test.ts drives expiry on a fake one.

/**
 * How long a successful pairing stays replayable. Mirrors the pairing code's
 * own 5-minute lifetime: as long as the PC would still be showing a code the
 * user could act on, a lost-reply retry of that code can still be honoured.
 */
export const PAIR_REPLAY_TTL_MS = 5 * 60 * 1000;

/** The body of a successful /pair response, minus anything request-specific. */
export interface PairReplayResult {
  readonly token: string;
  readonly name: string;
  readonly via?: string;
}

export interface PairReplayCache {
  /** Record the token issued for `code`, so an identical retry can replay it. */
  remember(code: string, result: PairReplayResult): void;
  /** The token previously issued for `code`, if still within the window. */
  lookup(code: string): PairReplayResult | null;
}

export interface PairReplayOptions {
  readonly ttlMs?: number;
  /** Injected clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

interface Entry {
  readonly result: PairReplayResult;
  readonly expires: number;
}

export function createPairReplayCache(options: PairReplayOptions = {}): PairReplayCache {
  const ttlMs = options.ttlMs ?? PAIR_REPLAY_TTL_MS;
  const now = options.now ?? Date.now;

  // Keyed by code. Kept small by pruning on every write, so a long-running host
  // that pairs occasionally never accumulates stale entries.
  const entries = new Map<string, Entry>();

  const prune = (at: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expires <= at) entries.delete(key);
    }
  };

  return {
    remember(code: string, result: PairReplayResult): void {
      if (!code) return;
      const at = now();
      prune(at);
      // Copy in so a later mutation of the caller's object cannot rewrite what
      // a retry will be handed back.
      entries.set(code, { result: { ...result }, expires: at + ttlMs });
    },

    lookup(code: string): PairReplayResult | null {
      if (!code) return null;
      const entry = entries.get(code);
      if (!entry) return null;
      if (entry.expires <= now()) {
        entries.delete(code);
        return null;
      }
      // Copy out so a caller cannot mutate the cached result in place.
      return { ...entry.result };
    },
  };
}
