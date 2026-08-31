// The paired-device list's data half, JSX-free so the parsing and the
// revocation reasoning run under node. Split out of sections.tsx when revoke
// arrived: which row is the phone in your hand, and what confirming will do
// to it, is exactly the kind of logic that must not live untested inside a
// component.

export interface PairedDevice {
  /**
   * The host's truncated token — identity for revocation, never rendered.
   * Kept now (it used to be dropped here) because it is the only name the
   * revoke route answers to; showing it on screen is still off the table.
   */
  readonly tokenPrefix: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeen: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Narrows the untyped `/devices` payload. A row without a usable prefix (an
 * older host, say) still lists — it just cannot be revoked from here, and the
 * UI says nothing rather than offering a button that would 400.
 */
export function parseDevices(payload: unknown): readonly PairedDevice[] {
  if (!isRecord(payload) || !Array.isArray(payload.devices)) return [];
  return payload.devices.flatMap((entry: unknown): PairedDevice[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return [];
    return [{
      tokenPrefix: typeof entry.tokenPrefix === 'string' ? entry.tokenPrefix : '',
      name: entry.name,
      createdAt: numberOr(entry.createdAt, 0),
      lastSeen: numberOr(entry.lastSeen, 0),
    }];
  });
}

/** The host refuses prefixes shorter than this — mirror it, don't rediscover it via a 400. */
const MIN_REVOKE_PREFIX = 4;

export function canRevoke(device: PairedDevice): boolean {
  return device.tokenPrefix.length >= MIN_REVOKE_PREFIX;
}

/** Whether this row is the very phone the user is holding. */
export function isSelfDevice(device: PairedDevice, ownToken: string | undefined): boolean {
  return canRevoke(device) && !!ownToken && ownToken.startsWith(device.tokenPrefix);
}

export interface RevocationCopy {
  readonly self: boolean;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
}

/**
 * The confirmation, worded before anything happens: what is about to be cut,
 * that it is immediate, and what getting back costs (§11.4 — name the
 * consequence, then act). Self-revocation is the same route but a different
 * event for the user, so it gets its own words, not a generic warning.
 */
export function revocationCopy(device: PairedDevice, self: boolean): RevocationCopy {
  if (self) {
    return {
      self: true,
      title: 'Log this phone out?',
      body: 'This is the phone in your hand. Revoking it un-pairs it from this computer '
        + 'immediately — the live screen, terminal and agent close, and coming back '
        + 'means a new pairing code from the computer itself.',
      confirmLabel: 'Revoke this phone',
    };
  }
  return {
    self: false,
    title: `Revoke ${device.name}?`,
    body: `${device.name} loses access to this computer the moment you confirm — any live `
      + 'screen or terminal it has open is cut with it. There is no undo; if it was a '
      + 'mistake, pair that device again with a new code.',
    confirmLabel: 'Revoke device',
  };
}
