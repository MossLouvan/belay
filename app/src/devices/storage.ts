// Persistence for the saved-computers store, plus the one-time migration from
// the old single-connection layout.
//
// Kept deliberately thin: every decision about *what* the store should contain
// lives in model.ts as pure functions, so the only thing here is reading,
// writing, and validating what came back off the disk.
//
// Where the tokens live: a device token is a standing key to a whole computer,
// so on a phone it goes in the OS keychain (expo-secure-store) rather than the
// plain AsyncStorage file, which is unencrypted and lands in device backups.
// SecureStore values are small (iOS warns above 2 KB), so the store blob stays
// in AsyncStorage with each token replaced by a marker, and the real token is
// keyed by computer id in SecureStore. The web build has no keychain and keeps
// tokens in the blob, exactly as before.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  DeviceStore, emptyStore, parseStore, migrateLegacy, LegacyConnection,
} from './model';

const STORE_KEY = 'tether.devices.v1';

/** The pre-v1 keys. Read once during migration, then removed. */
const LEGACY_HOST_KEY = 'tether.host';
const LEGACY_TOKEN_KEY = 'tether.token';
const LEGACY_NAME_KEY = 'tether.hostname';

/** What the blob holds in place of a token that lives in the keychain. */
const SECURE_MARK = '<keychain>';

const useKeychain = Platform.OS !== 'web';

/** SecureStore keys may only contain [A-Za-z0-9._-]; computer ids are freer. */
function secureKey(id: string): string {
  return 'tether.token.' + id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Load the store, migrating an old single connection if that is all we find.
 *
 * Never throws. A phone that cannot read its own storage should land on the
 * "add a computer" screen, not on a crash — and an unparseable store is
 * indistinguishable from a fresh install from the user's point of view.
 */
export async function loadStore(): Promise<DeviceStore> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = parseStore(await restoreTokens(JSON.parse(raw)));
      if (parsed) return parsed;
      // Present but unreadable: fall through to the legacy check rather than
      // silently discarding a connection the user may still have.
    }
  } catch {
    // Ignore and try the legacy path.
  }

  const legacy = await loadLegacy();
  if (!legacy) return emptyStore();

  const migrated = migrateLegacy(legacy, Date.now());
  // Persist immediately so the migration happens exactly once, then drop the
  // old keys — leaving them would let a later downgrade resurrect a stale
  // token that the user thinks they removed.
  await saveStore(migrated);
  await clearLegacy();
  return migrated;
}

export async function saveStore(store: DeviceStore): Promise<void> {
  try {
    const blob = useKeychain ? await stashTokens(store) : store;
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(blob));
  } catch (e: unknown) {
    // Surfaced rather than swallowed: if this fails the user will silently be
    // asked to pair again next launch, and they deserve to know why.
    console.warn('[devices] could not save the computer list:', messageOf(e));
    throw e;
  }
}

/**
 * Write every token to the keychain and return the blob to persist, with the
 * tokens replaced by the marker. Keychain entries for computers that are no
 * longer in the store are removed, so forgetting a computer really forgets it.
 */
async function stashTokens(store: DeviceStore): Promise<DeviceStore> {
  const keep = new Set(store.devices.map((d) => d.id));
  await Promise.all(store.devices.map((d) => SecureStore.setItemAsync(secureKey(d.id), d.token)));
  for (const id of await previousIds()) {
    if (!keep.has(id)) await SecureStore.deleteItemAsync(secureKey(id)).catch(() => undefined);
  }
  return { ...store, devices: store.devices.map((d) => ({ ...d, token: SECURE_MARK })) };
}

/** Ids in the blob currently on disk, so stale keychain entries can be dropped. */
async function previousIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const devices = raw ? (JSON.parse(raw) as { devices?: unknown }).devices : null;
    if (!Array.isArray(devices)) return [];
    return devices
      .map((d) => (d as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/**
 * Put the real tokens back into a freshly read blob before it is validated.
 * A marker whose keychain entry is missing becomes an empty token, which
 * parseStore drops — the user pairs that computer again rather than the app
 * carrying a computer it can never talk to.
 */
async function restoreTokens(blob: unknown): Promise<unknown> {
  const devices = (blob as { devices?: unknown } | null)?.devices;
  if (!useKeychain || !Array.isArray(devices)) return blob;
  const restored = await Promise.all(devices.map(async (d) => {
    const dev = d as { id?: unknown; token?: unknown };
    if (dev?.token !== SECURE_MARK || typeof dev.id !== 'string') return d;
    let token: string | null = null;
    try { token = await SecureStore.getItemAsync(secureKey(dev.id)); } catch { token = null; }
    return { ...dev, token: token ?? '' };
  }));
  return { ...(blob as object), devices: restored };
}

async function loadLegacy(): Promise<LegacyConnection | null> {
  try {
    const [host, token, hostName] = await Promise.all([
      AsyncStorage.getItem(LEGACY_HOST_KEY),
      AsyncStorage.getItem(LEGACY_TOKEN_KEY),
      AsyncStorage.getItem(LEGACY_NAME_KEY),
    ]);
    if (!host || !token) return null;
    return { host, token, hostName: hostName || 'My computer' };
  } catch {
    return null;
  }
}

async function clearLegacy(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([LEGACY_HOST_KEY, LEGACY_TOKEN_KEY, LEGACY_NAME_KEY]);
  } catch {
    // Harmless if it fails — loadStore prefers the v1 key from now on.
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
