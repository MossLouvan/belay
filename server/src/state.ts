// Persistent host state: identity, config, and the device token(s) a paired
// phone uses. Stored as tether-state.json (gitignored).
//
// This file holds long-lived bearer tokens that grant complete control of the
// machine — screen capture, keystroke injection and a shell. It is therefore
// written 0600 and written atomically: a torn write used to be silently
// recoverable as "no devices paired", which unpairs every phone you own with
// no log line explaining why.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

/**
 * Where state lives.
 *
 * Overridable because the default is `process.cwd()`, which means launching the
 * agent from a different directory silently creates a *new* empty state and the
 * user appears unpaired for no visible reason. A service manager that sets its
 * own working directory hits this immediately.
 */
const STATE_FILE = process.env.TETHER_STATE_FILE || join(process.cwd(), 'tether-state.json');

/** Owner read/write only — these are credentials, not config. */
const STATE_FILE_MODE = 0o600;

/** Current on-disk schema version, so future migrations have something to key on. */
const SCHEMA_VERSION = 1;

export type HostPlatform = 'darwin' | 'win32' | 'other';

export interface Device {
  readonly token: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeen: number;
}

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
}

function emptyState(): Persisted {
  return {
    version: SCHEMA_VERSION,
    hostId: randomUUID(),
    hostName: '',
    label: '',
    devices: [],
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
function isValidDevice(value: unknown): value is Device {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.token === 'string' && d.token.length > 0
    && typeof d.name === 'string'
    && typeof d.createdAt === 'number' && Number.isFinite(d.createdAt)
    && typeof d.lastSeen === 'number' && Number.isFinite(d.lastSeen);
}

/** Coerce whatever is on disk into a valid state, reporting what was dropped. */
function migrate(raw: unknown): Persisted {
  const base = emptyState();
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;

  const devices = Array.isArray(r.devices) ? r.devices : [];
  const valid = devices.filter(isValidDevice);
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
  };
}

export function loadState(): void {
  if (!existsSync(STATE_FILE)) {
    state = emptyState();
    return;
  }
  try {
    state = migrate(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
  } catch (e: unknown) {
    // Loud, because the consequence is every paired phone appearing unpaired.
    console.error(
      `[state] ${STATE_FILE} is unreadable and has been ignored — every paired ` +
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
function save(): void {
  const temporary = `${STATE_FILE}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: STATE_FILE_MODE });
    renameSync(temporary, STATE_FILE);
    // rename preserves the temp file's mode, but an older state file created
    // before this change would still be 0644, so re-assert it.
    chmodSync(STATE_FILE, STATE_FILE_MODE);
  } catch (e: unknown) {
    console.error(`[state] failed to save ${STATE_FILE}: ${e instanceof Error ? e.message : String(e)}`);
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
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

/** Which OS this agent is running on, as the app's device list needs it. */
export function getPlatform(): HostPlatform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'other';
}

// ---- devices -------------------------------------------------------------

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function addDevice(name: string): Device {
  const now = Date.now();
  const device: Device = {
    token: newToken(),
    name: name || 'iPhone',
    createdAt: now,
    lastSeen: now,
  };
  state = { ...state, devices: [...state.devices, device] };
  save();
  return device;
}

// Constant-time comparison so a token cannot be recovered by timing the check.
export function findDevice(token: string): Device | undefined {
  if (!token) return undefined;
  const candidate = Buffer.from(token);
  for (const d of state.devices) {
    const known = Buffer.from(d.token);
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
      return d;
    }
  }
  return undefined;
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
    devices: state.devices.map((d) => (d.token === device.token ? { ...d, lastSeen: at } : d)),
  };
}

/** Devices with tokens reduced to a display prefix — safe to send to a client. */
export function listDevices(): readonly DeviceSummary[] {
  return state.devices.map((d) => ({
    tokenPrefix: d.token.slice(0, TOKEN_PREFIX_LENGTH),
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
  const devices = state.devices.filter((d) => !d.token.startsWith(tokenPrefix));
  if (devices.length === before) return false;
  state = { ...state, devices };
  save();
  return true;
}

export function revokeAll(): void {
  state = { ...state, devices: [] };
  save();
}
