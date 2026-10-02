// Where the account session lives: the OS keychain (expo-secure-store), the
// same place the device tokens go (devices/storage.ts). Never AsyncStorage —
// it is unencrypted and lands in backups. The web build has no keychain and
// keeps the session in sessionStorage: gone when the tab closes, never on disk.

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { Account } from './api';
import { parsePhoneRegistration, serializePhoneRegistration } from './phone-registration';
import type { PhoneRegistration } from './phone-registration';

const SESSION_KEY = 'belay.account.session';
const ACCOUNT_KEY = 'belay.account.profile';
/** The id POST /devices gave this phone and the node id it was registered under (phone-registration.ts). */
const PHONE_DEVICE_KEY = 'belay.account.phoneDeviceId';

export interface StoredSession {
  readonly session: string;
  readonly account: Account;
}

const useKeychain = Platform.OS !== 'web';

async function read(key: string): Promise<string | null> {
  if (useKeychain) return SecureStore.getItemAsync(key);
  try { return globalThis.sessionStorage?.getItem(key) ?? null; } catch { return null; }
}

async function write(key: string, value: string | null): Promise<void> {
  if (useKeychain) {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
    return;
  }
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(key);
    else globalThis.sessionStorage?.setItem(key, value);
  } catch { /* private window: in-memory session only */ }
}

/** Never throws: an unreadable keychain is "signed out", not a crash. */
export async function loadSession(): Promise<StoredSession | null> {
  try {
    const [session, profile] = await Promise.all([read(SESSION_KEY), read(ACCOUNT_KEY)]);
    if (!session) return null;
    const account = profile ? (JSON.parse(profile) as Account) : null;
    if (!account || typeof account.id !== 'string') return null;
    return { session, account };
  } catch {
    return null;
  }
}

export async function saveSession(stored: StoredSession): Promise<void> {
  await write(SESSION_KEY, stored.session);
  await write(ACCOUNT_KEY, JSON.stringify(stored.account));
}

/** Sign out locally: the session, the profile and the phone registration go together. */
export async function clearSession(): Promise<void> {
  await Promise.all([write(SESSION_KEY, null), write(ACCOUNT_KEY, null), write(PHONE_DEVICE_KEY, null)]);
}

export const loadPhoneRegistration = (): Promise<PhoneRegistration | null> =>
  read(PHONE_DEVICE_KEY).then(parsePhoneRegistration, () => null);
export const savePhoneRegistration = (r: PhoneRegistration): Promise<void> => write(PHONE_DEVICE_KEY, serializePhoneRegistration(r));
