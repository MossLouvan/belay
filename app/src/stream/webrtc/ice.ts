// ICE candidate classification — the telemetry that decides the whole business.
//
// The consensus architecture hangs every downstream cost decision (how many
// relay PoPs, the relay bandwidth budget, where the paid tier line sits) on ONE
// measured number: what fraction of real sessions connect peer-to-peer versus
// fall back to a relay. That number is unknowable until it is measured against
// Belay's actual user population — phones on CGNAT-heavy mobile carriers, the
// worst case for direct connectivity — so the classification that produces it
// ships in the very first WebRTC build.
//
// Pure string/shape logic over the candidate types WebRTC already reports. No
// RTCPeerConnection here, so it runs under the test runner unchanged.

/** The four ICE candidate types, plus a catch-all for anything unrecognized. */
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

/** How a connected pair actually routes, derived from the two candidate types. */
export type ConnectionKind = 'direct-local' | 'direct-reflexive' | 'relayed' | 'unknown';

/**
 * Pulls the candidate type out of an SDP candidate line or an RTCIceCandidate's
 * `type` field. Accepts both because the browser gives you the object and raw
 * SDP munging gives you the string, and the caller should not care which.
 */
export function candidateType(input: string | { type?: string; candidate?: string } | null | undefined): CandidateType {
  if (!input) return 'unknown';
  if (typeof input !== 'string') {
    if (input.type) return normalizeType(input.type);
    return candidateType(input.candidate ?? '');
  }
  // SDP form: "candidate:... typ srflx ...". The token after `typ` is the type.
  const match = /(?:^|\s)typ\s+(\w+)/.exec(input);
  return match ? normalizeType(match[1]!) : 'unknown';
}

function normalizeType(raw: string): CandidateType {
  switch (raw.toLowerCase()) {
    case 'host':
      return 'host';
    case 'srflx':
      return 'srflx';
    case 'prflx':
      return 'prflx';
    case 'relay':
      return 'relay';
    default:
      return 'unknown';
  }
}

/**
 * Classifies the selected candidate PAIR. Relayed if EITHER end is a relay —
 * one relayed leg means the session is paying for a relay, which is what the
 * cost model cares about. A host-host pair is direct on the LAN; a pair
 * involving a server-reflexive candidate is direct across NATs (the hole-punch
 * worked). Anything with a relay is the expensive path.
 */
export function classifyPair(local: CandidateType, remote: CandidateType): ConnectionKind {
  if (local === 'relay' || remote === 'relay') return 'relayed';
  if (local === 'unknown' || remote === 'unknown') return 'unknown';
  if (local === 'host' && remote === 'host') return 'direct-local';
  return 'direct-reflexive';
}

/** Rolls per-session outcomes into the direct/relayed ratio the model needs. */
export class IceStats {
  private readonly counts: Record<ConnectionKind, number> = {
    'direct-local': 0,
    'direct-reflexive': 0,
    relayed: 0,
    unknown: 0,
  };

  record(kind: ConnectionKind): void {
    this.counts[kind] += 1;
  }

  recordPair(local: CandidateType, remote: CandidateType): void {
    this.record(classifyPair(local, remote));
  }

  /** Fraction of *classified* sessions that avoided a relay, 0..1. */
  directRatio(): number | null {
    const direct = this.counts['direct-local'] + this.counts['direct-reflexive'];
    const classified = direct + this.counts.relayed;
    if (classified === 0) return null;
    return direct / classified;
  }

  snapshot(): Readonly<Record<ConnectionKind, number>> & { directRatio: number | null } {
    return { ...this.counts, directRatio: this.directRatio() };
  }
}
