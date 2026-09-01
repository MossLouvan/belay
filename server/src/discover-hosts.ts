// Which other computers on this tailnet are running Belay right now.
//
// Once the phone is paired with one computer, that computer can introduce the
// others: ask the Tailscale daemon who else is on the owner's tailnet, keep
// the peers that share this host's login, and probe each survivor's /health to
// see whether a Belay host answers there. Every answer becomes a one-tap
// "add" on the phone — no IP, no port, no code (the tailnet pair path in
// pairing is already code-less).
//
// The whois check is not optional politeness. `status --json` also lists nodes
// *shared into* this tailnet from someone else's account — machines the owner
// can reach but does not own. tailnet.ts already establishes the rule for
// code-less pairing: a peer counts only when `tailscale whois` says it shares
// this host's login. Discovery applies the identical test, so a shared node
// can never be offered as "your computer".
//
// Bounded on every axis: peers are capped before any CLI call, each whois has
// the CLI timeout, each probe its own abort deadline, and everything runs
// concurrently — so a tailnet full of peers costs one round of parallel
// checks, not a sum of them. Results are cached briefly because the computer
// list polls this.

import { isCgnatAddress } from './addresses.js';
import { normalizeIp, parseSelfLogin, tailscaleStatus, whois } from './tailnet.js';
import type { Whois } from './tailnet.js';

/**
 * Most tailnets are a handful of machines; a peer beyond this many is far
 * more likely to be an exit node zoo than a Belay host. The cap is what keeps
 * one request's worth of CLI calls and probes finite no matter what the
 * daemon reports.
 */
const PEER_CAP = 16;

/**
 * Per-peer /health deadline. A Belay host on the same tailnet answers in tens
 * of milliseconds even through a relay; anything slower is either not Belay
 * or not worth advertising as one tap away.
 */
const PROBE_TIMEOUT_MS = 1500;

/** The computer list polls this route; one scan serves a burst of polls. */
const CACHE_MS = 10_000;

// ---- parsing -------------------------------------------------------------

/** One peer as `tailscale status --json` reports it. */
export interface TailnetPeer {
  readonly hostName: string;
  readonly os: string;
  readonly ip: string;
  readonly online: boolean;
}

/**
 * Pull the peer list out of `status --json`. Every field is treated as
 * optional — the shape has been stable, but a daemon a few versions away must
 * degrade to "no peers", never to a throw. Peers without an IPv4 tailnet
 * address are dropped: there is nothing to probe.
 */
export function parsePeers(json: string): readonly TailnetPeer[] {
  try {
    const j = JSON.parse(json) as { Peer?: Record<string, unknown> };
    const peers = j?.Peer;
    if (typeof peers !== 'object' || peers === null) return [];
    const out: TailnetPeer[] = [];
    for (const value of Object.values(peers)) {
      const p = value as { HostName?: unknown; OS?: unknown; TailscaleIPs?: unknown; Online?: unknown };
      const ips = Array.isArray(p?.TailscaleIPs) ? p.TailscaleIPs : [];
      const ip = ips.find((a): a is string => typeof a === 'string' && isCgnatAddress(a));
      if (!ip) continue;
      out.push({
        hostName: typeof p.HostName === 'string' ? p.HostName : ip,
        os: typeof p.OS === 'string' ? p.OS : '',
        ip,
        online: p.Online === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** What a peer's /health must say for it to count as a Belay host. */
export interface PeerHealth {
  readonly id: string;
  readonly label: string;
  readonly platform: string;
  readonly addresses: readonly { readonly kind: string; readonly url: string }[];
}

/**
 * Read a /health reply, or null when whatever answered is not a Belay host.
 * The `id` is the gate: it is the key the phone stores computers under, so an
 * answer without one cannot be de-duplicated against the saved list. A host
 * old enough to lack an id is invisible to discovery but still reachable by
 * typing its address — the manual path this feature accelerates, not replaces.
 */
export function parsePeerHealth(body: unknown): PeerHealth | null {
  if (typeof body !== 'object' || body === null) return null;
  const j = body as Record<string, unknown>;
  if (j.ok !== true || typeof j.id !== 'string' || !j.id) return null;
  const addresses = Array.isArray(j.addresses)
    ? j.addresses.filter((a): a is { kind: string; url: string } => {
        const c = a as { kind?: unknown; url?: unknown };
        return typeof c?.kind === 'string' && typeof c?.url === 'string' && c.url.length > 0;
      })
    : [];
  return {
    id: j.id,
    label: typeof j.label === 'string' && j.label ? j.label : (typeof j.name === 'string' ? j.name : j.id),
    platform: typeof j.platform === 'string' ? j.platform : 'other',
    addresses,
  };
}

// ---- the scan ------------------------------------------------------------

/** A Belay host found on the tailnet, ready for the phone to add. */
export interface DiscoveredHost {
  readonly id: string;
  readonly label: string;
  readonly platform: string;
  /** The peer's name on the tailnet, e.g. "DESKTOP-BB4FRER". */
  readonly tailnetName: string;
  /** The URL this host reached it on — proven from here, worth trying first. */
  readonly url: string;
  /** Everything the peer advertises, so the phone can race its own way in. */
  readonly addresses: readonly { readonly kind: string; readonly url: string }[];
}

/**
 * What the route returns. Three honest shapes, because each has a different
 * fix (docs/DESIGN.md §11.4): `tailscale: false` with what actually failed;
 * peers but no hosts (start the host agent over there); hosts.
 */
export interface DiscoveryReply {
  readonly tailscale: boolean;
  /** Only when tailscale is false: the observed reason, not a guess. */
  readonly detail?: string;
  /** Own online peers considered, minus the asker. Grounds "none ran Belay". */
  readonly peers: number;
  readonly hosts: readonly DiscoveredHost[];
}

/** The CLI and network edges, injected so tests never touch either. */
export interface DiscoveryDeps {
  readonly status: () => Promise<string | null>;
  readonly whois: (ip: string) => Promise<Whois | null>;
  readonly probe: (url: string, timeoutMs: number) => Promise<PeerHealth | null>;
}

/** Probe one peer's /health under a hard deadline, aborting, not abandoning. */
export async function probePeerHealth(url: string, timeoutMs: number): Promise<PeerHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url + '/health', { signal: controller.signal });
    if (!res.ok) return null;
    return parsePeerHealth(await res.json());
  } catch {
    // Nothing listening, a refused connection, or the deadline — all the same
    // fact: no Belay host answered there right now.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const defaultDeps: DiscoveryDeps = {
  status: tailscaleStatus,
  whois,
  probe: probePeerHealth,
};

interface ScanResult {
  readonly tailscale: boolean;
  readonly detail?: string;
  /** Own online peers, keyed by tailnet IP so the asker can be subtracted. */
  readonly ownPeerIps: readonly string[];
  readonly hosts: readonly (DiscoveredHost & { readonly ip: string })[];
}

/**
 * One full pass: peers → ownership (whois) → probe. Uncached and injectable,
 * so tests can drive every branch without a tailscale binary or a socket.
 */
export async function scanTailnet(port: number, deps: DiscoveryDeps = defaultDeps): Promise<ScanResult> {
  const raw = await deps.status();
  if (raw === null) {
    return {
      tailscale: false,
      detail: 'the tailscale CLI did not answer — Tailscale may not be installed or running',
      ownPeerIps: [],
      hosts: [],
    };
  }
  const self = parseSelfLogin(raw);
  if (!self) {
    return {
      tailscale: false,
      detail: 'Tailscale is running but not signed in to an account',
      ownPeerIps: [],
      hosts: [],
    };
  }

  const online = parsePeers(raw).filter((p) => p.online).slice(0, PEER_CAP);

  const checks = await Promise.all(online.map(async (peer) => {
    const who = await deps.whois(peer.ip);
    if (!who || who.login.toLowerCase() !== self.toLowerCase()) return null;
    const url = `http://${peer.ip}:${port}`;
    const health = await deps.probe(url, PROBE_TIMEOUT_MS);
    return { peer, url, health };
  }));

  const owned = checks.filter((c): c is NonNullable<typeof c> => c !== null);
  const hosts = owned.flatMap((c) => c.health === null ? [] : [{
    id: c.health.id,
    label: c.health.label,
    platform: c.health.platform,
    tailnetName: c.peer.hostName,
    url: c.url,
    addresses: c.health.addresses,
    ip: c.peer.ip,
  }]);

  return { tailscale: true, ownPeerIps: owned.map((c) => c.peer.ip), hosts };
}

// ---- cached wrapper ------------------------------------------------------

let cache: { at: number; port: number; scan: ScanResult } | null = null;

/** Test hook: module-level caches outlive tests otherwise. */
export function resetDiscoveryCache(): void {
  cache = null;
}

/** Whether a peer IP is the socket address doing the asking. The socket side
 *  arrives IPv4-mapped on dual-stack listeners; the peer side never does. */
function sameIp(peerIp: string, requesterIp: string | undefined): boolean {
  return requesterIp !== undefined && peerIp === normalizeIp(requesterIp);
}

/**
 * The scan, cached, with the asker subtracted.
 *
 * The asker (the phone) is filtered here rather than before the scan because
 * the scan is shared: whichever paired device polls first pays for it, and
 * everyone else reads it. The phone never shows up as a host anyway — nothing
 * answers /health on it — but it must not inflate the peer count either, or
 * "2 devices, none running Belay" would be counting the asker.
 *
 * Computers the phone has already saved are NOT filtered here: this host has
 * no idea which machines a given phone holds tokens for, and different phones
 * hold different lists. The app filters against its own saved computers.
 */
export async function discoverPeerHosts(
  port: number,
  requesterIp: string | undefined,
  deps: DiscoveryDeps = defaultDeps,
): Promise<DiscoveryReply> {
  if (!cache || cache.port !== port || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), port, scan: await scanTailnet(port, deps) };
  }
  const scan = cache.scan;
  const peers = scan.ownPeerIps.filter((ip) => !sameIp(ip, requesterIp)).length;
  const hosts = scan.hosts
    .filter((h) => !sameIp(h.ip, requesterIp))
    .map(({ ip: _ip, ...host }) => host);
  return scan.tailscale
    ? { tailscale: true, peers, hosts }
    : { tailscale: false, detail: scan.detail, peers: 0, hosts: [] };
}
