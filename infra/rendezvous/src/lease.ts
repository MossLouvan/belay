// Presence as leases: a host is reachable exactly when it holds a live lease.
//
// The consensus architecture's answer to "how does a client find its host
// without a central mutable session store": the host ANNOUNCES a short-TTL
// lease and re-announces at half-life, forever. Presence is then a pure
// function of (leases seen recently, now) — a rendezvous instance that
// restarts, or a brand-new instance behind the load balancer, converges to the
// correct picture within one TTL without any handoff, replication, or shared
// database. Losing lease state costs at most `maxTtlSec` of "host looks
// offline", never correctness.
//
// Trust model: the lease's mailboxId is an opaque rendezvous identity derived
// on the host from pairing material (HKDF — see server/src/webrtc/envelope.ts).
// The rendezvous cannot mint one for a pairing it does not know, and learning a
// mailboxId only lets an attacker *find* a host, never talk to it: admission to
// the session is still gated end-to-end by the sealed signaling. Expiry is
// computed from the server's clock — a client-supplied absolute time is never
// trusted.

export const LEASE_LIMITS = Object.freeze({
  /** Announce cadence bounds. Short enough that "offline" is prompt, long
   *  enough that a fleet of hosts is not a heartbeat DDoS on ourselves. */
  minTtlSec: 15,
  maxTtlSec: 120,
  defaultTtlSec: 60,
  idPattern: /^[A-Za-z0-9._-]{8,128}$/,
  /** Optional connectivity hints (e.g. "region:iad"). Opaque to the lease. */
  maxHints: 8,
  maxHintBytes: 128,
  /** Table cap: beyond this, new hosts are refused rather than evicting live
   *  ones — refusal is visible and retryable, silent eviction is not. */
  maxHosts: 100_000,
});

export interface HostLease {
  readonly mailboxId: string;
  /** Host-chosen monotonic sequence; lets a live lease reject replays. */
  readonly seq: number;
  readonly expiresAtMs: number;
  readonly hints: readonly string[];
}

export interface LeaseAnnounce {
  readonly mailboxId: string;
  readonly seq: number;
  readonly ttlSec?: number;
  readonly hints?: readonly string[];
}

export type AnnounceValidation =
  | { readonly ok: true; readonly announce: LeaseAnnounce; readonly ttlSec: number }
  | { readonly ok: false; readonly error: string };

/** Validate one raw announce frame. Never throws. */
export function validateAnnounce(input: unknown): AnnounceValidation {
  if (!input || typeof input !== 'object') return { ok: false, error: 'announce is not an object' };
  const msg = input as Record<string, unknown>;

  if (typeof msg.mailboxId !== 'string' || !LEASE_LIMITS.idPattern.test(msg.mailboxId)) {
    return { ok: false, error: 'invalid mailboxId' };
  }
  if (typeof msg.seq !== 'number' || !Number.isSafeInteger(msg.seq) || msg.seq < 0) {
    return { ok: false, error: 'invalid seq' };
  }

  let ttlSec: number = LEASE_LIMITS.defaultTtlSec;
  if (msg.ttlSec !== undefined) {
    if (typeof msg.ttlSec !== 'number' || !Number.isFinite(msg.ttlSec)) {
      return { ok: false, error: 'invalid ttlSec' };
    }
    ttlSec = Math.min(LEASE_LIMITS.maxTtlSec, Math.max(LEASE_LIMITS.minTtlSec, Math.floor(msg.ttlSec)));
  }

  let hints: readonly string[] = [];
  if (msg.hints !== undefined) {
    if (!Array.isArray(msg.hints)) return { ok: false, error: 'hints is not an array' };
    if (msg.hints.length > LEASE_LIMITS.maxHints) return { ok: false, error: 'too many hints' };
    for (const h of msg.hints) {
      if (typeof h !== 'string' || h.length === 0 || Buffer.byteLength(h, 'utf8') > LEASE_LIMITS.maxHintBytes) {
        return { ok: false, error: 'invalid hint' };
      }
    }
    hints = [...msg.hints];
  }

  return {
    ok: true,
    announce: { mailboxId: msg.mailboxId, seq: msg.seq, ttlSec, hints },
    ttlSec,
  };
}

export function isLive(lease: HostLease | undefined, nowMs: number): lease is HostLease {
  return lease !== undefined && lease.expiresAtMs > nowMs;
}

export type AcceptOutcome =
  | { readonly accepted: true; readonly lease: HostLease }
  | { readonly accepted: false; readonly reason: string };

/**
 * Pure lease-succession rule: an announce replaces the current lease when the
 * current one is dead (a restarted host may legitimately reset seq), or when
 * its seq is strictly newer. A replayed or reordered announce against a live
 * lease is rejected — a captured announce cannot keep a host looking online
 * after it stopped renewing, nor roll its hints back.
 */
export function acceptAnnounce(
  current: HostLease | undefined,
  announce: LeaseAnnounce,
  ttlSec: number,
  nowMs: number,
): AcceptOutcome {
  if (isLive(current, nowMs) && announce.seq <= current.seq) {
    return { accepted: false, reason: `stale seq ${announce.seq} (live lease at seq ${current.seq})` };
  }
  return {
    accepted: true,
    lease: {
      mailboxId: announce.mailboxId,
      seq: announce.seq,
      expiresAtMs: nowMs + ttlSec * 1000,
      hints: announce.hints ?? [],
    },
  };
}

export interface LeaseTable {
  /** Validate + apply one announce. Returns the outcome, never throws. */
  announce(input: unknown): AcceptOutcome;
  /** The live lease for a mailbox, or null. Expired leases are never returned. */
  lookup(mailboxId: string): HostLease | null;
  /** Drop expired entries. Called internally; exposed for tests and cron. */
  prune(): void;
  size(): number;
}

/**
 * The per-instance lease table. In-memory ON PURPOSE: the re-announce protocol
 * is the replication mechanism, so this needs no Redis and no cross-instance
 * chatter — the property that keeps the rendezvous horizontally scalable.
 * Routing by mailboxId hash (see docs/SCALABILITY.md) keeps a host and its
 * clients on the same instance in the steady state.
 */
export function createLeaseTable(now: () => number = Date.now, maxHosts: number = LEASE_LIMITS.maxHosts): LeaseTable {
  const leases = new Map<string, HostLease>();
  let lastPruneMs = 0;

  const prune = (): void => {
    const at = now();
    for (const [id, lease] of leases) {
      if (!isLive(lease, at)) leases.delete(id);
    }
    lastPruneMs = at;
  };

  const maybePrune = (): void => {
    // Amortized: a full sweep at most once per second, not per announce.
    if (now() - lastPruneMs >= 1000) prune();
  };

  return {
    announce(input: unknown) {
      maybePrune();
      const validated = validateAnnounce(input);
      if (!validated.ok) return { accepted: false, reason: validated.error };

      const { announce, ttlSec } = validated;
      const nowMs = now();
      const current = leases.get(announce.mailboxId);
      if (!current && leases.size >= maxHosts) {
        return { accepted: false, reason: 'lease table full' };
      }
      const outcome = acceptAnnounce(current, announce, ttlSec, nowMs);
      if (outcome.accepted) leases.set(announce.mailboxId, outcome.lease);
      return outcome;
    },

    lookup(mailboxId: string): HostLease | null {
      const lease = leases.get(mailboxId);
      if (!isLive(lease, now())) return null;
      return lease;
    },

    prune,

    size(): number {
      prune();
      return leases.size;
    },
  };
}
