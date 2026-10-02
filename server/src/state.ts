// Persistent host state: identity, config, and the device token(s) a paired
// phone uses. Stored as belay-state.json (gitignored).
//
// This file holds the hashes of long-lived bearer tokens that grant complete
// control of the machine — screen capture, keystroke injection and a shell.
// Only hashes, so reading the file impersonates nobody; still, it is written
// 0600 and written atomically: a torn write used to be silently
// recoverable as "no devices paired", which unpairs every phone you own with
// no log line explaining why.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname, homedir } from 'node:os';

import { productEnv } from './env.js';
import { resolveStateFile, LEGACY_STATE_FILE_NAME } from './data-dir.js';

/**
 * Where state lives. See data-dir.ts: an explicit BELAY_STATE_FILE wins, then
 * a file already beside the process (pre-data-dir installs), then the
 * per-user data directory that `npx belay-host` relies on.
 */
const CONFIGURED_STATE_FILE = productEnv('STATE_FILE');
const STATE_FILE = resolveStateFile(
  CONFIGURED_STATE_FILE,
  process.cwd(),
  { platform: process.platform, home: homedir(), env: process.env },
  existsSync,
);

/**
 * Where the pre-rename install kept the same state. Read once, on first boot
 * after the rename, when the new file does not exist yet — otherwise every
 * paired phone would silently appear unpaired, which is precisely the failure
 * mode this module's atomic writes exist to prevent. Never written and never
 * deleted: an old host binary may still be running against it, and a file of
 * device tokens is the last thing to clean up speculatively.
 */
const LEGACY_STATE_FILE = join(process.cwd(), LEGACY_STATE_FILE_NAME);

/** The file this process reads and writes, for the startup banner. */
export function stateFilePath(): string { return STATE_FILE; }

/** Owner read/write only — these are credentials, not config. */
const STATE_FILE_MODE = 0o600;

/**
 * Current on-disk schema version. v2 stores `tokenHash` (SHA-256 of the
 * token) where v1 stored the token itself; a v1 file is rehashed on load and
 * rewritten on the next save, so nobody has to pair again.
 */
const SCHEMA_VERSION = 2;

export type HostPlatform = 'darwin' | 'win32' | 'other';

/**
 * A paired device as kept in memory and on disk. Only the hash of its token
 * is stored: the file used to hold the raw bearer tokens, so anyone who could
 * read it — a backup, a sync folder, one paired phone via the file browser —
 * could impersonate every other paired device.
 */
export interface Device {
  /** SHA-256 of the bearer token, hex. Doubles as the device's stable id. */
  readonly tokenHash: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeen: number;
  /**
   * Public handle the client names itself by when it asks for a proof of the
   * host's identity (device-proof.ts), and the HMAC key for that proof. Both
   * are minted at pairing; a device paired before they existed has neither
   * and can only be reached over links that are private anyway (transport.ts).
   */
  readonly id?: string;
  readonly secret?: string;
}

/** A freshly paired device, carrying the raw token — the only time it exists. */
export interface PairedDevice extends Device {
  readonly token: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKEN_HASH = /^[0-9a-f]{64}$/;

/**
 * A device as exposed over the API: the token is truncated to a display prefix.
 *
 * This is a genuinely different type from `Device` — passing one back into
 * `findDevice` would never match. It used to be cast to `Device`, which hid
 * exactly that mistake.
 */
export interface DeviceSummary {
  readonly tokenPrefix: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeen: number;
}

interface Persisted {
  readonly version: number;
  /** Stable machine identity. The app keys saved computers on this, never on a URL. */
  readonly hostId: string;
  readonly hostName: string;
  /** User-editable display name, e.g. "MacBook Air". Defaults to the host name. */
  readonly label: string;
  readonly devices: readonly Device[];
  /** "Keep running with the lid closed" switch (lid-mode.ts). */
  readonly lidClosedMode: boolean;
  /** Windows: the LIDACTION pair saved before arming, so a crash can be undone. */
  readonly lidSavedLidAction: LidAction | null;
}

export interface LidAction { readonly ac: number; readonly dc: number }

function emptyState(): Persisted {
  return {
    version: SCHEMA_VERSION,
    hostId: randomUUID(),
    hostName: '',
    label: '',
    devices: [],
    lidClosedMode: false,
    lidSavedLidAction: null,
  };
}

let state: Persisted = emptyState();

/** Number of characters of a token shown in listings. */
const TOKEN_PREFIX_LENGTH = 8;

// ---- load / save ---------------------------------------------------------

/**
 * Validate one persisted device.
 *
 * Every field is checked because a hand-edited or truncated file previously
 * produced a `Device` whose `token` was not a string, and `Buffer.from()` on it
 * threw from inside the auth middleware — making *every* authenticated request
 * fail with a 500, permanently, with no clue as to why.
 */
function isValidDevice(value: unknown): value is Device | (Omit<Device, 'tokenHash'> & { token: string }) {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  const credential = (typeof d.tokenHash === 'string' && TOKEN_HASH.test(d.tokenHash))
    || (typeof d.token === 'string' && d.token.length > 0);
  return credential
    && typeof d.name === 'string'
    && typeof d.createdAt === 'number' && Number.isFinite(d.createdAt)
    && typeof d.lastSeen === 'number' && Number.isFinite(d.lastSeen)
    && (d.id === undefined || typeof d.id === 'string')
    && (d.secret === undefined || typeof d.secret === 'string');
}

/**
 * A v1 entry carries the raw token; hash it in place. The result is exactly
 * what a v2 pairing would have written, so the phone's token keeps working.
 */
function hashLegacyDevice(d: Device | (Omit<Device, 'tokenHash'> & { token: string })): Device {
  if ('tokenHash' in d && typeof d.tokenHash === 'string') {
    const { token: _dropped, ...rest } = d as Device & { token?: string };
    return rest;
  }
  const { token, ...rest } = d as Omit<Device, 'tokenHash'> & { token: string };
  return { ...rest, tokenHash: hashToken(token) };
}

/** Whether any persisted device still carries a raw token (a v1 file). */
function hasPlaintextTokens(raw: unknown): boolean {
  const devices = (raw as { devices?: unknown })?.devices;
  return Array.isArray(devices)
    && devices.some((d) => typeof (d as { token?: unknown })?.token === 'string');
}

/** Coerce whatever is on disk into a valid state, reporting what was dropped. */
function migrate(raw: unknown): Persisted {
  const base = emptyState();
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;

  const devices = Array.isArray(r.devices) ? r.devices : [];
  const valid = devices.filter(isValidDevice).map(hashLegacyDevice);
  if (valid.length !== devices.length) {
    console.warn(
      `[state] dropped ${devices.length - valid.length} malformed device entr` +
      `${devices.length - valid.length === 1 ? 'y' : 'ies'} from ${STATE_FILE}`,
    );
  }

  const hostName = typeof r.hostName === 'string' ? r.hostName : '';
  return {
    version: SCHEMA_VERSION,
    // Pre-v1 files have no hostId; mint one and keep everything else. The
    // devices stay valid because tokens are independent of host identity.
    hostId: typeof r.hostId === 'string' && r.hostId ? r.hostId : base.hostId,
    hostName,
    label: typeof r.label === 'string' && r.label ? r.label : hostName,
    devices: valid,
    lidClosedMode: r.lidClosedMode === true,
    lidSavedLidAction: isLidAction(r.lidSavedLidAction) ? r.lidSavedLidAction : null,
  };
}

function isLidAction(v: unknown): v is LidAction {
  const a = v as { ac?: unknown; dc?: unknown } | null;
  return typeof a === 'object' && a !== null && Number.isInteger(a.ac) && Number.isInteger(a.dc);
}

export function loadState(): void {
  // Prefer the current file; fall back to the pre-rename one so an upgrade
  // keeps every pairing. The fallback only applies to the default location —
  // an explicit BELAY_STATE_FILE (or legacy TETHER_STATE_FILE) points
  // at exactly one file and gets no second guess.
  const canFallBack = !CONFIGURED_STATE_FILE && existsSync(LEGACY_STATE_FILE);
  const source = existsSync(STATE_FILE)
    ? STATE_FILE
    : (canFallBack ? LEGACY_STATE_FILE : null);
  if (source === null) {
    state = emptyState();
    return;
  }
  if (source === LEGACY_STATE_FILE) {
    console.log(`[state] read ${LEGACY_STATE_FILE}; the next change is saved as ${STATE_FILE} (the old file is kept)`);
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(source, 'utf8'));
    const hadHostId =
      !!parsed && typeof parsed === 'object' &&
      typeof (parsed as { hostId?: unknown }).hostId === 'string' &&
      (parsed as { hostId?: string }).hostId !== '';
    state = migrate(parsed);
    // If migrate had to mint a hostId (pre-v1 file) or we read the legacy file,
    // persist immediately. Otherwise the mint is lost on exit and the host's
    // identity changes every restart, so every paired phone sees a mismatch and
    // marks the computer unreachable. Saving also promotes legacy -> STATE_FILE.
    // A v1 file (raw tokens) is saved for the same reason: the rewrite is what
    // gets the plaintext off the disk.
    if (!hadHostId || source === LEGACY_STATE_FILE || hasPlaintextTokens(parsed)) save();
  } catch (e: unknown) {
    // Loud, because the consequence is every paired phone appearing unpaired.
    console.error(
      `[state] ${source} is unreadable and has been ignored — every paired ` +
      `device will need to pair again. Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
    state = emptyState();
  }
}

/**
 * Write state atomically.
 *
 * `writeFileSync` truncates in place, so a crash or power loss between truncate
 * and flush leaves a partial file that fails to parse — and the load path
 * treats that as "nothing is paired". Writing to a sibling and renaming makes
 * the swap atomic on POSIX and Windows alike.
 */
function save(): boolean {
  const temporary = `${STATE_FILE}.tmp`;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: STATE_FILE_MODE });
    renameSync(temporary, STATE_FILE);
    // rename preserves the temp file's mode, but an older state file created
    // before this change would still be 0644, so re-assert it.
    chmodSync(STATE_FILE, STATE_FILE_MODE);
    return true;
  } catch (e: unknown) {
    console.error(`[state] failed to save ${STATE_FILE}: ${e instanceof Error ? e.message : String(e)}`);
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
    return false;
  }
}

// ---- identity ------------------------------------------------------------

/** Stable id for this machine. The app keys saved computers on this. */
export function getHostId(): string {
  return state.hostId;
}

export function getHostName(): string {
  return state.hostName || '';
}

export function setHostName(name: string): void {
  state = { ...state, hostName: name, label: state.label || name };
  save();
}

/** Friendly, user-editable name shown in the app's computer list. */
export function getLabel(): string {
  return state.label || state.hostName || hostname();
}

export function setLabel(label: string): void {
  state = { ...state, label };
  save();
}

export function getLidClosedMode(): boolean { return state.lidClosedMode; }
export function setLidClosedMode(on: boolean): void {
  state = { ...state, lidClosedMode: on };
  save();
}
export function getLidSavedAction(): LidAction | null { return state.lidSavedLidAction; }
export function setLidSavedAction(v: LidAction | null): void {
  state = { ...state, lidSavedLidAction: v };
  save();
}

/** Which OS this agent is running on, as the app's device list needs it. */
export function getPlatform(): HostPlatform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'other';
}

// ---- devices -------------------------------------------------------------

function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function addDevice(name: string): PairedDevice {
  const now = Date.now();
  const token = newToken();
  const device: Device = {
    tokenHash: hashToken(token),
    name: name || 'iPhone',
    createdAt: now,
    lastSeen: now,
    id: randomBytes(8).toString('hex'),
    secret: newToken(),
  };
  state = { ...state, devices: [...state.devices, device] };
  save();
  return { ...device, token };
}

// Constant-time comparison of hashes so a token cannot be recovered by timing
// the check. Every hash is the same length, so the length check is only a
// guard against a malformed entry.
export function findDevice(token: string): Device | undefined {
  if (!token) return undefined;
  const candidate = Buffer.from(hashToken(token));
  for (const d of state.devices) {
    const known = Buffer.from(d.tokenHash);
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
      return d;
    }
  }
  return undefined;
}

/** The device that named itself `id` in a proof request; never by token. */
export function findDeviceById(id: string): Device | undefined {
  if (!id) return undefined;
  return state.devices.find((d) => d.id === id);
}

/**
 * Record that a device was just seen.
 *
 * Rebuilt rather than mutated in place. Not persisted on every call — that
 * would mean a disk write per frame — so a `lastSeen` update can be lost on an
 * unclean exit, which is harmless.
 */
export function touchDevice(device: Device): void {
  const at = Date.now();
  state = {
    ...state,
    devices: state.devices.map((d) => (d.tokenHash === device.tokenHash ? { ...d, lastSeen: at } : d)),
  };
}

/**
 * Devices with a display prefix of the token *hash* — safe to send to a
 * client: nothing derived from the hash authenticates.
 */
export function listDevices(): readonly DeviceSummary[] {
  return state.devices.map((d) => ({
    tokenPrefix: d.tokenHash.slice(0, TOKEN_PREFIX_LENGTH),
    name: d.name,
    createdAt: d.createdAt,
    lastSeen: d.lastSeen,
  }));
}

/** How many devices are paired. Cheaper and clearer than listDevices().length. */
export function deviceCount(): number {
  return state.devices.length;
}

export function revokeDevice(tokenPrefix: string): boolean {
  const before = state.devices.length;
  const devices = state.devices.filter((d) => !d.tokenHash.startsWith(tokenPrefix));
  if (devices.length === before) return false;
  state = { ...state, devices };
  // true only if the removal is durable; a failed write means the token could
  // come back on restart, and the caller should surface that rather than lie.
  return save();
}

export function revokeAll(): boolean {
  state = { ...state, devices: [] };
  return save();
}
