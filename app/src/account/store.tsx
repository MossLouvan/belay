// App-wide account state: the stored session, the account's device list, and
// what a screen can ask for — sign in, sign out (here or everywhere), delete,
// and the security-emails setting.
//
// The session credential never leaves session.ts except as the bearer the
// API client reads through `session()`; screens see only `account`.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { AccountsError, DEFAULT_ACCOUNTS_URL, createAccountsApi } from './api';
import type { Account, AccountDevice, AccountsApi, SessionResult } from './api';
import { clearSession, loadPhoneRegistration, loadSession, savePhoneRegistration, saveSession } from './session';
import { registrationNeeded } from './phone-registration';
import { getTunnelIdentity, stopTunnel } from './tunnel-identity';
import { deviceNameFor } from '../connect/pair-flow';

/** Override for local development: EXPO_PUBLIC_ACCOUNTS_API=http://localhost:8787/v1 */
const ACCOUNTS_API_URL = process.env.EXPO_PUBLIC_ACCOUNTS_API || undefined;
/** Where account calls go; a LAN one is subject to iOS Local Network permission. */
export const ACCOUNTS_BASE_URL = ACCOUNTS_API_URL ?? DEFAULT_ACCOUNTS_URL;

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
  /** POST /me/sessions/revoke-all, then forget locally. Throws when the server could not be reached. */
  signOutEverywhere: () => Promise<void>;
  /** PATCH /me {securityEmails}; the stored account follows. */
  setSecurityEmails: (on: boolean) => Promise<void>;
  /** DELETE /devices/:id — unlinks a computer from the account. */
  removeDevice: (id: string) => Promise<void>;
  /** DELETE /me, then forget everything local. */
  deleteAccount: () => Promise<void>;
  refreshDevices: () => Promise<void>;
}

const noop = async () => undefined;
const AccountContext = createContext<Ctx>({
  ready: false, account: null, devices: [], api: createAccountsApi({ session: () => null }),
  signIn: noop, signOut: noop, signOutEverywhere: noop, setSecurityEmails: noop, removeDevice: noop, deleteAccount: noop, refreshDevices: noop,
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
    await Promise.all([clearSession(), stopTunnel()]);
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

  /**
   * POST /devices once per node id. Starting the tunnel is what yields the
   * node id, so this is also where the tunnel comes up for a signed-in phone.
   * A node id that changed since the last registration (the pre-FFI
   * placeholder giving way to the real key) registers again and drops the
   * stale phone from the account, best effort.
   */
  const registerPhone = useCallback(async () => {
    const [stored, { nodeId }] = await Promise.all([loadPhoneRegistration(), getTunnelIdentity()]);
    if (!registrationNeeded(stored, nodeId)) return;
    const name = Constants.deviceName || deviceNameFor(Platform.OS);
    const device = await api.registerPhone(name, nodeId, Platform.OS);
    await savePhoneRegistration({ id: device.id, nodeId });
    if (stored && stored.id !== device.id) await api.removeDevice(stored.id).catch(() => undefined);
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

  /** Delete the session server-side, then locally. Offline still signs out here. */
  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    await forgetLocally();
  }, [api, forgetLocally]);

  /** Unlike signOut, a failure is reported: "everywhere" must not be pretended. A dead session is already signed out. */
  const signOutEverywhere = useCallback(async () => {
    try {
      await api.revokeAllSessions();
    } catch (e: unknown) {
      if (!(e instanceof AccountsError && e.code === 'unauthorized')) throw e;
    }
    await forgetLocally();
  }, [api, forgetLocally]);

  // ponytail: the toggle shows what this phone last saw; a change made on
  // another phone appears after the next sign-in. Refresh via GET /me if that matters.
  const setSecurityEmails = useCallback(async (on: boolean) => {
    const updated = await api.setSecurityEmails(on);
    setAccount(updated);
    if (sessionRef.current) await saveSession({ session: sessionRef.current, account: updated });
  }, [api]);

  const removeDevice = useCallback(async (id: string) => {
    await api.removeDevice(id);
    await refreshDevices();
  }, [api, refreshDevices]);

  const deleteAccount = useCallback(async () => {
    await api.deleteMe();
    await forgetLocally();
  }, [api, forgetLocally]);

  const value = useMemo<Ctx>(() => ({
    ready, account, devices, api, signIn, signOut, signOutEverywhere, setSecurityEmails, removeDevice, deleteAccount, refreshDevices,
  }), [ready, account, devices, api, signIn, signOut, signOutEverywhere, setSecurityEmails, removeDevice, deleteAccount, refreshDevices]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): Ctx {
  return useContext(AccountContext);
}
