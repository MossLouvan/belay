// App-wide connection state.
//
// Owns the list of saved computers, which one is active, and the work of
// turning "the MacBook" into a concrete URL that answers right now. Screens ask
// for the active computer; they never deal with addresses.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  Connection, checkHost, setConnection as setClientConnection,
  clearConnection as clearClientConnection,
} from './api';
import {
  DeviceStore, SavedDevice, emptyStore, activeDevice as pickActive,
  upsertDevice, setActive, removeDevice, renameDevice, recordSuccess,
  orderAddresses, adoptRealId, isLegacyId, findDevice,
} from './devices/model';
import { loadStore, saveStore } from './devices/storage';
import { raceAddresses } from './devices/race';

/** Where the app is in the process of reaching the active computer. */
export type ConnectPhase = 'idle' | 'connecting' | 'connected' | 'unreachable';

interface Ctx {
  /** Finished the initial load attempt. */
  ready: boolean;
  /** The resolved connection, or null when nothing is reachable yet. */
  connection: Connection | null;
  devices: readonly SavedDevice[];
  active: SavedDevice | undefined;
  phase: ConnectPhase;
  /** Which address won the race, for display. */
  activeUrl: string | null;

  addDevice: (device: SavedDevice) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  forget: (id: string) => Promise<void>;
  rename: (id: string, label: string) => Promise<void>;
  /** Re-race the active computer's addresses. */
  reconnect: () => Promise<void>;
  /** Forget every computer. Only for an explicit "start over". */
  disconnect: () => Promise<void>;
}

const ConnectionContext = createContext<Ctx>({
  ready: false,
  connection: null,
  devices: [],
  active: undefined,
  phase: 'idle',
  activeUrl: null,
  addDevice: async () => {},
  switchTo: async () => {},
  forget: async () => {},
  rename: async () => {},
  reconnect: async () => {},
  disconnect: async () => {},
});

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [store, setStore] = useState<DeviceStore>(emptyStore);
  const [connection, setConn] = useState<Connection | null>(null);
  const [phase, setPhase] = useState<ConnectPhase>('idle');
  const [activeUrl, setActiveUrl] = useState<string | null>(null);

  /**
   * Guards against an older connect attempt finishing after a newer one and
   * overwriting it — switching computers twice in quick succession would
   * otherwise land you on whichever host happened to be slower.
   */
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  /** Persist and hold in state together, so the two can never disagree. */
  const commit = useCallback(async (next: DeviceStore) => {
    setStore(next);
    await saveStore(next).catch(() => { /* already reported in storage */ });
  }, []);

  /**
   * Find an address for `device` that answers, and point the client at it.
   *
   * Every address is raced concurrently, so at home the LAN entry wins in a few
   * milliseconds, and on cellular it fails immediately and the tunnel wins. The
   * winner is recorded so the next attempt tries it first.
   */
  const connectTo = useCallback(async (device: SavedDevice, from: DeviceStore): Promise<void> => {
    const attempt = ++attemptRef.current;
    setPhase('connecting');

    const ordered = orderAddresses(device.addresses, device.lastKnownGoodUrl);
    const winner = await raceAddresses(ordered, async (url, signal) => {
      const health = await checkHost(url, signal);
      return { ok: health.ok, hostId: health.id };
    });

    // A newer attempt started while this one was in flight; its result wins.
    if (!mountedRef.current || attempt !== attemptRef.current) return;

    if (!winner) {
      setConn(null);
      clearClientConnection();
      setActiveUrl(null);
      // A real, actionable state — the computer is asleep, or this network
      // cannot reach it — not something to hide behind a spinner.
      setPhase('unreachable');
      return;
    }

    const resolved: Connection = {
      host: winner.url,
      token: device.token,
      hostName: device.label,
    };
    setClientConnection(resolved);
    setConn(resolved);
    setActiveUrl(winner.url);
    setPhase('connected');

    let next = recordSuccess(from, device.id, winner.url, winner.rttMs, Date.now());
    // A computer carried over from the old single-connection layout has a
    // synthesised id; the first host that reports a real one lets it become an
    // ordinary entry, keeping its token.
    if (winner.hostId && isLegacyId(device.id)) {
      next = adoptRealId(next, device.id, winner.hostId);
    }
    await commit(next);
  }, [commit]);

  // Initial load: read the saved computers, then try to reach the active one.
  useEffect(() => {
    let live = true;
    loadStore()
      .then(async (loaded) => {
        if (!live) return;
        setStore(loaded);
        setReady(true);
        const device = pickActive(loaded);
        if (device) await connectTo(device, loaded);
      })
      .catch(() => { if (live) setReady(true); });
    return () => { live = false; };
    // connectTo is stable (its only dependency is the stable `commit`).
  }, [connectTo]);

  const addDevice = useCallback(async (device: SavedDevice) => {
    const next = upsertDevice(store, device);
    await commit(next);
    await connectTo(device, next);
  }, [store, commit, connectTo]);

  const switchTo = useCallback(async (id: string) => {
    const next = setActive(store, id);
    await commit(next);
    const device = findDevice(next, id);
    if (device) await connectTo(device, next);
  }, [store, commit, connectTo]);

  const forget = useCallback(async (id: string) => {
    const wasActive = store.activeId === id;
    const next = removeDevice(store, id);
    await commit(next);

    const stillActive = pickActive(next);
    if (!stillActive) {
      setConn(null);
      clearClientConnection();
      setActiveUrl(null);
      setPhase('idle');
      return;
    }
    // Only re-race when we just removed the computer we were talking to.
    if (wasActive) await connectTo(stillActive, next);
  }, [store, commit, connectTo]);

  const rename = useCallback(async (id: string, label: string) => {
    await commit(renameDevice(store, id, label));
  }, [store, commit]);

  const reconnect = useCallback(async () => {
    const device = pickActive(store);
    if (device) await connectTo(device, store);
  }, [store, connectTo]);

  const disconnect = useCallback(async () => {
    await commit(emptyStore());
    setConn(null);
    clearClientConnection();
    setActiveUrl(null);
    setPhase('idle');
  }, [commit]);

  const active = pickActive(store);

  const value = useMemo<Ctx>(() => ({
    ready,
    connection,
    devices: store.devices,
    active,
    phase,
    activeUrl,
    addDevice,
    switchTo,
    forget,
    rename,
    reconnect,
    disconnect,
  }), [
    ready, connection, store.devices, active, phase, activeUrl,
    addDevice, switchTo, forget, rename, reconnect, disconnect,
  ]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  return useContext(ConnectionContext);
}
