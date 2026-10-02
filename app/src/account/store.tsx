// App-wide account state: the stored session, the account's device list, and
// the three things a screen can ask for — sign in, sign out, delete.
//
// The session credential never leaves session.ts except as the bearer the
// API client reads through `session()`; screens see only `account`.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { AccountsError, createAccountsApi } from './api';
import type { Account, AccountDevice, AccountsApi, SessionResult } from './api';
import { clearSession, loadPhoneDeviceId, loadSession, saveSession, savePhoneDeviceId } from './session';
import { getTunnelIdentity } from './tunnel-identity';
import { deviceNameFor } from '../connect/pair-flow';

/** Override for local development: EXPO_PUBLIC_ACCOUNTS_API=http://localhost:8787/v1 */
const ACCOUNTS_API_URL = process.env.EXPO_PUBLIC_ACCOUNTS_API || undefined;

interface Ctx {
  /** The stored session has been read (or found absent). */
  ready: boolean;
  account: Account | null;
  /** Computers and phones linked to the account; empty when signed out. */
  devices: readonly AccountDevice[];
  api: AccountsApi;
  /** Store a fresh session from any of the three sign-in routes. */
  signIn: (result: SessionResult) => Promise<void>;
  signOut: () => Promise<void>;
  /** DELETE /me, then forget everything local. */
  deleteAccount: () => Promise<void>;
  refreshDevices: () => Promise<void>;
}

const noop = async () => undefined;
const AccountContext = createContext<Ctx>({
  ready: false, account: null, devices: [], api: createAccountsApi({ session: () => null }),
  signIn: noop, signOut: noop, deleteAccount: noop, refreshDevices: noop,
});

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [devices, setDevices] = useState<readonly AccountDevice[]>([]);
  const sessionRef = useRef<string | null>(null);

  const api = useMemo(() => createAccountsApi({ baseUrl: ACCOUNTS_API_URL, session: () => sessionRef.current }), []);

  const forgetLocally = useCallback(async () => {
    sessionRef.current = null;
    setAccount(null);
    setDevices([]);
    await clearSession();
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!sessionRef.current) return;
    try {
      setDevices(await api.listDevices());
    } catch (e: unknown) {
      // A dead session is the one failure the list cannot recover from.
      if (e instanceof AccountsError && e.code === 'unauthorized') await forgetLocally();
    }
  }, [api, forgetLocally]);

  /** POST /devices once per sign-in; the id is kept so a relaunch does not re-register. */
  const registerPhone = useCallback(async () => {
    if (await loadPhoneDeviceId()) return;
    const { nodeId } = await getTunnelIdentity();
    const name = Constants.deviceName || deviceNameFor(Platform.OS);
    const device = await api.registerPhone(name, nodeId, Platform.OS);
    await savePhoneDeviceId(device.id);
  }, [api]);

  useEffect(() => {
    let live = true;
    loadSession()
      .then(async (stored) => {
        if (!live || !stored) return;
        sessionRef.current = stored.session;
        setAccount(stored.account);
        await Promise.all([registerPhone().catch(() => undefined), refreshDevices()]);
      })
      .finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [registerPhone, refreshDevices]);

  const signIn = useCallback(async (result: SessionResult) => {
    sessionRef.current = result.session;
    setAccount(result.account);
    await saveSession(result);
    // Registration is best effort here: the sign-in already succeeded, and
    // the next launch retries it.
    await Promise.all([registerPhone().catch(() => undefined), refreshDevices()]);
  }, [registerPhone, refreshDevices]);

  const deleteAccount = useCallback(async () => {
    await api.deleteMe();
    await forgetLocally();
  }, [api, forgetLocally]);

  const value = useMemo<Ctx>(() => ({
    ready, account, devices, api, signIn, signOut: forgetLocally, deleteAccount, refreshDevices,
  }), [ready, account, devices, api, signIn, forgetLocally, deleteAccount, refreshDevices]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): Ctx {
  return useContext(AccountContext);
}
