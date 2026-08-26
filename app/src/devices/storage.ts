// Persistence for the saved-computers store, plus the one-time migration from
// the old single-connection layout.
//
// Kept deliberately thin: every decision about *what* the store should contain
// lives in model.ts as pure functions, so the only thing here is reading,
// writing, and validating what came back off the disk.

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DeviceStore, emptyStore, parseStore, migrateLegacy, LegacyConnection,
} from './model';

const STORE_KEY = 'tether.devices.v1';

/** The pre-v1 keys. Read once during migration, then removed. */
const LEGACY_HOST_KEY = 'tether.host';
const LEGACY_TOKEN_KEY = 'tether.token';
const LEGACY_NAME_KEY = 'tether.hostname';

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
      const parsed = parseStore(JSON.parse(raw));
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
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e: unknown) {
    // Surfaced rather than swallowed: if this fails the user will silently be
    // asked to pair again next launch, and they deserve to know why.
    console.warn('[devices] could not save the computer list:', messageOf(e));
    throw e;
  }
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
