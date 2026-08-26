// The saved-computers data model.
//
// This file is the fix for the single biggest gap between what Tether does and
// what it is for. The app used to store one host URL and one token in three
// flat keys, which meant pairing with the Windows PC *destroyed* the Mac's
// token — and that even one machine could only ever be remembered at one
// address, so pairing at home and then leaving the house left every request
// pointed at a stale LAN IP.
//
// Two ideas fix both:
//
//   1. A computer is keyed on the host's own stable id, never on a URL. URLs
//      are the thing that changes; the id is not.
//   2. A computer holds a *list* of addresses. The app races them at connect
//      time, so it silently takes the fast LAN path at home and the tunnel on
//      cellular, with the user never choosing.
//
// Everything here is pure so it can be unit tested without React or storage.
// All updates return new objects — nothing is mutated in place.

export type Platform = 'darwin' | 'win32' | 'other';
export type AddressKind = 'lan' | 'tailscale' | 'magicdns' | 'relay';

export interface HostAddress {
  readonly kind: AddressKind;
  readonly url: string;
  /** When this address last answered. Drives the next connect's ordering. */
  readonly lastOkAt?: number;
  readonly lastRttMs?: number;
}

export interface SavedDevice {
  /** Host-generated UUID. The primary key. Never the URL. */
  readonly id: string;
  readonly label: string;
  readonly platform: Platform;
  readonly addresses: readonly HostAddress[];
  /** Bearer token for this (phone, host) pair. Independent of address. */
  readonly token: string;
  readonly addedAt: number;
  readonly lastConnectedAt?: number;
  /** Address that worked most recently — tried first next time. */
  readonly lastKnownGoodUrl?: string;
}

export interface DeviceStore {
  readonly version: 1;
  readonly devices: readonly SavedDevice[];
  readonly activeId: string | null;
}

export const STORE_VERSION = 1;

export function emptyStore(): DeviceStore {
  return { version: STORE_VERSION, devices: [], activeId: null };
}

/**
 * Preference order when nothing is known about recent success.
 *
 * LAN first because it is fastest and cheapest when it works. Note this is only
 * an ordering hint: every address is raced concurrently, so a dead LAN entry
 * costs one abandoned request, not a delay.
 */
const KIND_ORDER: Record<AddressKind, number> = {
  lan: 0,
  magicdns: 1,
  tailscale: 2,
  relay: 3,
};

// ---- addresses -----------------------------------------------------------

/**
 * Merge freshly-advertised addresses into what we already had.
 *
 * The host is authoritative about *kind*, but it does not know our measured
 * RTTs, so per-address success metadata is preserved across a refresh. An
 * address the host no longer advertises is dropped — that is how a stale LAN
 * IP eventually disappears instead of being retried forever.
 */
export function mergeAddresses(
  existing: readonly HostAddress[],
  advertised: readonly HostAddress[],
): readonly HostAddress[] {
  const known = new Map(existing.map((a) => [a.url, a]));
  return advertised.map((a) => {
    const previous = known.get(a.url);
    return previous ? { ...a, lastOkAt: previous.lastOkAt, lastRttMs: previous.lastRttMs } : a;
  });
}

/**
 * The order to try addresses in.
 *
 * Last-known-good first — if it worked 30 seconds ago it will almost certainly
 * work now, and trying it first makes reconnects feel instant. Then by kind,
 * then by most-recently-successful.
 */
export function orderAddresses(
  addresses: readonly HostAddress[],
  lastKnownGoodUrl?: string,
): readonly HostAddress[] {
  return [...addresses].sort((a, b) => {
    if (a.url === lastKnownGoodUrl) return -1;
    if (b.url === lastKnownGoodUrl) return 1;
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0);
  });
}

/**
 * Whether this device can still be reached after its LAN address changes.
 *
 * A device with only LAN addresses is one DHCP lease away from being
 * unreachable from outside the house, with no way to self-heal — the phone
 * cannot ask the host for its new address because it cannot reach the host.
 * The UI uses this to warn before the user is stranded rather than after.
 */
export function isReachableFromAnywhere(device: SavedDevice): boolean {
  return device.addresses.some((a) => a.kind !== 'lan');
}

// ---- store updates (all immutable) ---------------------------------------

export function findDevice(store: DeviceStore, id: string): SavedDevice | undefined {
  return store.devices.find((d) => d.id === id);
}

export function activeDevice(store: DeviceStore): SavedDevice | undefined {
  return store.activeId ? findDevice(store, store.activeId) : undefined;
}

/**
 * Add a computer, or update it in place if it is already saved.
 *
 * Re-pairing the same machine must not create a duplicate entry, and must not
 * lose the addresses we already learned — which is why this matches on id.
 */
export function upsertDevice(store: DeviceStore, device: SavedDevice): DeviceStore {
  const existing = findDevice(store, device.id);
  const merged: SavedDevice = existing
    ? {
        ...existing,
        ...device,
        addresses: mergeAddresses(existing.addresses, device.addresses),
      }
    : device;

  return {
    ...store,
    devices: existing
      ? store.devices.map((d) => (d.id === device.id ? merged : d))
      : [...store.devices, merged],
    activeId: device.id,
  };
}

/** Refresh a device's advertised addresses without touching its token. */
export function updateAddresses(
  store: DeviceStore,
  id: string,
  advertised: readonly HostAddress[],
): DeviceStore {
  return {
    ...store,
    devices: store.devices.map((d) =>
      d.id === id ? { ...d, addresses: mergeAddresses(d.addresses, advertised) } : d),
  };
}

/** Record that an address just worked, so the next connect tries it first. */
export function recordSuccess(
  store: DeviceStore,
  id: string,
  url: string,
  rttMs: number,
  at: number,
): DeviceStore {
  return {
    ...store,
    devices: store.devices.map((d) => {
      if (d.id !== id) return d;
      return {
        ...d,
        lastConnectedAt: at,
        lastKnownGoodUrl: url,
        addresses: d.addresses.map((a) =>
          a.url === url ? { ...a, lastOkAt: at, lastRttMs: rttMs } : a),
      };
    }),
  };
}

export function setActive(store: DeviceStore, id: string | null): DeviceStore {
  if (id !== null && !findDevice(store, id)) return store;
  return { ...store, activeId: id };
}

export function renameDevice(store: DeviceStore, id: string, label: string): DeviceStore {
  return {
    ...store,
    devices: store.devices.map((d) => (d.id === id ? { ...d, label } : d)),
  };
}

/**
 * Forget one computer.
 *
 * Deliberately scoped to a single device: "Disconnect" used to clear the one
 * global connection, which meant removing the Mac also threw away the Windows
 * PC. If the removed device was active, the next one becomes active so the app
 * still has somewhere to go.
 */
export function removeDevice(store: DeviceStore, id: string): DeviceStore {
  const devices = store.devices.filter((d) => d.id !== id);
  const activeId = store.activeId === id ? (devices[0]?.id ?? null) : store.activeId;
  return { ...store, devices, activeId };
}

// ---- migration -----------------------------------------------------------

/** The pre-v1 layout: three flat keys holding a single connection. */
export interface LegacyConnection {
  readonly host: string;
  readonly token: string;
  readonly hostName: string;
}

/**
 * Fold a pre-v1 single connection into a store.
 *
 * Nobody should have to re-pair because we changed our storage format. The
 * legacy layout has no host id, so one is synthesised from the URL — it is
 * replaced with the host's real id on the first successful connect, at which
 * point the entry becomes indistinguishable from a freshly paired one.
 */
export function migrateLegacy(legacy: LegacyConnection | null, at: number): DeviceStore {
  if (!legacy?.host || !legacy?.token) return emptyStore();

  const device: SavedDevice = {
    id: `legacy:${legacy.host}`,
    label: legacy.hostName || 'My computer',
    platform: 'other',
    addresses: [{ kind: 'lan', url: legacy.host }],
    token: legacy.token,
    addedAt: at,
    lastKnownGoodUrl: legacy.host,
  };
  return { version: STORE_VERSION, devices: [device], activeId: device.id };
}

/** True for an entry that still carries a synthesised id from the migration. */
export function isLegacyId(id: string): boolean {
  return id.startsWith('legacy:');
}

/**
 * Replace a migrated device's synthetic id with the host's real one.
 *
 * Called the first time a legacy entry reaches a host that reports an id. The
 * token, addresses and label are all kept — only the key changes.
 */
export function adoptRealId(store: DeviceStore, legacyId: string, realId: string): DeviceStore {
  const device = findDevice(store, legacyId);
  if (!device || !isLegacyId(legacyId)) return store;

  // If the real id is already saved, the legacy entry is a duplicate of a
  // computer that was re-paired the new way; drop it rather than fork it.
  if (findDevice(store, realId)) return removeDevice(store, legacyId);

  const adopted: SavedDevice = { ...device, id: realId };
  return {
    ...store,
    devices: store.devices.map((d) => (d.id === legacyId ? adopted : d)),
    activeId: store.activeId === legacyId ? realId : store.activeId,
  };
}

/** Validate anything read back from storage before trusting it. */
export function parseStore(raw: unknown): DeviceStore | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== STORE_VERSION || !Array.isArray(r.devices)) return null;

  const devices = r.devices.filter(isSavedDevice);
  const activeId = typeof r.activeId === 'string' && devices.some((d) => d.id === r.activeId)
    ? r.activeId
    : (devices[0]?.id ?? null);

  return { version: STORE_VERSION, devices, activeId };
}

function isSavedDevice(value: unknown): value is SavedDevice {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.id === 'string' && d.id.length > 0
    && typeof d.label === 'string'
    && typeof d.token === 'string' && d.token.length > 0
    && Array.isArray(d.addresses)
    && d.addresses.every(isHostAddress);
}

function isHostAddress(value: unknown): value is HostAddress {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return typeof a.url === 'string' && a.url.length > 0 && typeof a.kind === 'string';
}
