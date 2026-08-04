// Brute-force guard for the pairing endpoint.
//
// A 6-digit code is only 10^6 wide, and on its own that is fine *if a wrong
// guess costs something*. Without a cost, an attacker walks the entire space in
// minutes — and because the host keeps minting a fresh code every 5 minutes
// while unpaired, there is no natural end to the attempt window either. The
// code space is not the defence; the rate limit is.
//
// Two independent limits, because they stop different attacks:
//
//   per-client  a single source is locked out after a few failures. Stops the
//               obvious script.
//   per-code    failures from *all* sources are counted against the live code,
//               and blowing that budget burns the code immediately. Stops a
//               distributed attempt from outlasting any one code, which a
//               per-client limit alone cannot do.
//
// State is per-process and deliberately not persisted: a restart is not a
// meaningful bypass, since the pairing code is regenerated on restart anyway.

/** Tunables, grouped so the whole policy is readable in one place. */
export const PAIR_GUARD_DEFAULTS = {
  /** Wrong guesses one client may make before it is locked out. */
  maxFailuresPerClient: 5,
  /** How long a locked-out client stays locked out. */
  lockoutMs: 15 * 60 * 1000,
  /** Wrong guesses from all clients combined that invalidate the current code. */
  maxFailuresPerCode: 20,
  /** Idle time after which a client's failure record is forgotten. */
  clientTtlMs: 15 * 60 * 1000,
  /** Cap on tracked clients, so the map cannot grow without bound. */
  maxTrackedClients: 10_000,
} as const;

export type PairGuardOptions = typeof PAIR_GUARD_DEFAULTS;

/** Outcome of asking whether a client may attempt a pairing right now. */
export interface PairAttemptDecision {
  readonly allowed: boolean;
  /** Seconds until the client may try again. Zero when allowed. */
  readonly retryAfterSec: number;
}

/** Outcome of recording a failed attempt. */
export interface PairFailureOutcome {
  /** True when this failure exhausted the per-code budget and the code must be burned. */
  readonly burnCode: boolean;
  /** True when this failure locked the client out. */
  readonly clientLockedOut: boolean;
}

export interface PairGuard {
  /** Whether this client may attempt now. Does not record anything. */
  check(clientId: string): PairAttemptDecision;
  /** Record a wrong guess. Returns what the caller must do about it. */
  recordFailure(clientId: string): PairFailureOutcome;
  /** Record a correct guess — clears that client's record. */
  recordSuccess(clientId: string): void;
  /** Reset the per-code failure budget. Call whenever a new code is minted. */
  resetCodeBudget(): void;
  /** Failures counted against the live code. Exposed for tests and diagnostics. */
  failuresAgainstCode(): number;
}

interface ClientRecord {
  readonly failures: number;
  /** Timestamp of the most recent failure, used for both TTL and lockout. */
  readonly lastFailureAt: number;
}

/**
 * Build a guard. `now` is injectable so tests can drive the clock instead of
 * sleeping — the same approach `cpu.ts` takes for its sampler.
 */
export function createPairGuard(
  options: Partial<PairGuardOptions> = {},
  now: () => number = Date.now,
): PairGuard {
  const config: PairGuardOptions = { ...PAIR_GUARD_DEFAULTS, ...options };
  const clients = new Map<string, ClientRecord>();
  let failuresThisCode = 0;

  /** Drop records that have aged out, and hard-cap the map size. */
  const prune = (at: number): void => {
    for (const [id, record] of clients) {
      if (at - record.lastFailureAt > config.clientTtlMs) clients.delete(id);
    }
    // If a flood of distinct sources still overflows the cap, evict the oldest.
    // Insertion order is close enough to age order for this purpose.
    while (clients.size > config.maxTrackedClients) {
      const oldest = clients.keys().next();
      if (oldest.done) break;
      clients.delete(oldest.value);
    }
  };

  const lockoutRemainingMs = (record: ClientRecord, at: number): number => {
    if (record.failures < config.maxFailuresPerClient) return 0;
    const elapsed = at - record.lastFailureAt;
    return Math.max(0, config.lockoutMs - elapsed);
  };

  return {
    check(clientId: string): PairAttemptDecision {
      const at = now();
      const record = clients.get(clientId);
      if (!record) return { allowed: true, retryAfterSec: 0 };

      const remaining = lockoutRemainingMs(record, at);
      if (remaining <= 0) {
        // Lockout served. Forget the record so the client starts clean rather
        // than being locked out again by a single further mistake.
        if (record.failures >= config.maxFailuresPerClient) clients.delete(clientId);
        return { allowed: true, retryAfterSec: 0 };
      }
      return { allowed: false, retryAfterSec: Math.ceil(remaining / 1000) };
    },

    recordFailure(clientId: string): PairFailureOutcome {
      const at = now();
      prune(at);

      const previous = clients.get(clientId);
      const stale = previous !== undefined && at - previous.lastFailureAt > config.clientTtlMs;
      const priorFailures = previous && !stale ? previous.failures : 0;
      // Rebuilt rather than mutated — the record is a value, not a container.
      const record: ClientRecord = { failures: priorFailures + 1, lastFailureAt: at };
      clients.set(clientId, record);

      failuresThisCode += 1;

      return {
        burnCode: failuresThisCode >= config.maxFailuresPerCode,
        clientLockedOut: record.failures >= config.maxFailuresPerClient,
      };
    },

    recordSuccess(clientId: string): void {
      clients.delete(clientId);
    },

    resetCodeBudget(): void {
      failuresThisCode = 0;
    },

    failuresAgainstCode(): number {
      return failuresThisCode;
    },
  };
}
