// Pick the address that actually works, right now, without asking the user.
//
// This is the piece that makes a saved computer feel like one thing rather than
// a list of URLs. At home the LAN address wins because it answers in a few
// milliseconds; on cellular it fails instantly and the tunnel wins. The user
// never picks, and never has to know why it changed.
//
// Shaped after Happy Eyeballs (RFC 8305): fire at every candidate more or less
// at once, take the first success, and cancel the rest. The important detail is
// *cancel* — abandoning a fetch without aborting leaves it running, free to
// resolve later and clobber a newer result. `checkHost` in api.ts already takes
// an AbortSignal for exactly this reason.

/**
 * Just enough of an address for the racer to work with.
 *
 * Deliberately structural rather than importing the model type: the racer has
 * no opinion about *which* address should be preferred — that policy lives in
 * `orderAddresses`, and callers pass the result in already sorted. Keeping the
 * two apart means the racing logic is testable with plain objects.
 */
export interface RaceableAddress {
  readonly url: string;
}

/** How long a single candidate gets before it is given up on. */
export const PROBE_TIMEOUT_MS = 4000;

/**
 * Delay between starting each candidate.
 *
 * Not zero: staggering means the usually-correct first choice normally wins
 * outright and the others are cancelled before they cost anything. Not large
 * either, because a dead first candidate must not add noticeable latency.
 */
export const PROBE_STAGGER_MS = 250;

export interface ProbeResult {
  readonly url: string;
  readonly rttMs: number;
  /** Host identity from /health, when the host reported one. */
  readonly hostId?: string;
}

/** Probes one URL. Injected so the racer is testable without a network. */
export type Probe = (url: string, signal: AbortSignal) => Promise<{ ok: boolean; hostId?: string }>;

export interface RaceOptions {
  readonly timeoutMs?: number;
  readonly staggerMs?: number;
  readonly now?: () => number;
  /** Injected for tests; real callers use the default timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Race every address and return the first that answers.
 *
 * `ordered` must already be in preference order — see `orderAddresses`.
 *
 * Resolves null when none do — which is a meaningful, actionable state (the
 * computer is asleep, or you are on a network that cannot reach it) and must be
 * surfaced as such rather than as an endless reconnect spinner.
 */
export async function raceAddresses(
  ordered: readonly RaceableAddress[],
  probe: Probe,
  options: RaceOptions = {},
): Promise<ProbeResult | null> {
  if (ordered.length === 0) return null;

  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const staggerMs = options.staggerMs ?? PROBE_STAGGER_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  // One controller for the whole race: the winner aborts every straggler.
  const raceController = new AbortController();
  let settled = false;

  const attempts = ordered.map(async (address, index): Promise<ProbeResult | null> => {
    // Stagger, but bail immediately if someone else already won.
    if (index > 0) {
      await sleep(staggerMs * index);
      if (settled || raceController.signal.aborted) return null;
    }

    const perAttempt = new AbortController();
    const abortAll = () => perAttempt.abort();
    raceController.signal.addEventListener('abort', abortAll);
    const timer = setTimeout(abortAll, timeoutMs);

    const started = now();
    try {
      const result = await probe(address.url, perAttempt.signal);
      if (!result.ok) return null;
      return { url: address.url, rttMs: now() - started, hostId: result.hostId };
    } catch {
      // A failed or aborted probe is not exceptional — it is the normal case
      // for every address that is not the right one on this network.
      return null;
    } finally {
      clearTimeout(timer);
      raceController.signal.removeEventListener('abort', abortAll);
    }
  });

  const winner = await firstSuccess(attempts, () => { settled = true; raceController.abort(); });
  // Cancel anything still in flight even when everyone failed, so no request
  // outlives the race.
  raceController.abort();
  return winner;
}

/**
 * Resolve with the first non-null result, or null once all have resolved.
 *
 * `Promise.any` is not usable here: a candidate that fails resolves with null
 * rather than rejecting, so there is nothing for `any` to skip past.
 */
function firstSuccess(
  attempts: readonly Promise<ProbeResult | null>[],
  onWin: () => void,
): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    let outstanding = attempts.length;
    let done = false;

    for (const attempt of attempts) {
      attempt
        .then((result) => {
          if (done) return;
          if (result) {
            done = true;
            onWin();
            resolve(result);
            return;
          }
          outstanding -= 1;
          if (outstanding === 0) { done = true; resolve(null); }
        })
        .catch(() => {
          if (done) return;
          outstanding -= 1;
          if (outstanding === 0) { done = true; resolve(null); }
        });
    }

    if (attempts.length === 0) resolve(null);
  });
}
