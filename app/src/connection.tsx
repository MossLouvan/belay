// App-wide connection state.
//
// Owns the list of saved computers, which one is active, and the work of
// turning "the MacBook" into a concrete URL that answers right now. Screens ask
// for the active computer; they never deal with addresses.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  Connection, checkHost, challengeHost, setConnection as setClientConnection,
  clearConnection as clearClientConnection, setRecoveryHandler, revokeSelf,
} from './api';
import {
  DeviceStore, SavedDevice, emptyStore, activeDevice as pickActive,
  upsertDevice, setActive, renameDevice, recordSuccess,
  orderAddresses, adoptRealId, findDevice,
} from './devices/model';
import { forgetDevice, revokeAtVerifiedHost } from './devices/forget';
import { isUnresolved } from './devices/token-resolve';
import { pinAddresses, pinEnforced, randomBytes } from './devices/pinning';
import { verifyHost } from './devices/verify-host';
import type { TrustProblem } from './devices/verify-host';
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
  /**
   * Why the active computer was refused although something answered: it
   * could not prove it is the paired host, or this phone's pairing predates
   * the host's certificate and must be redone. Null whenever `phase` is not
   * 'unreachable', and null for a plain "nothing answered".
   */
  trustProblem: TrustProblem | null;

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
  trustProblem: null,
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
  const [trustProblem, setTrustProblem] = useState<TrustProblem | null>(null);

  /**
   * Guards against an older connect attempt finishing after a newer one and
   * overwriting it — switching computers twice in quick succession would
   * otherwise land you on whichever host happened to be slower.
   */
  const attemptRef = useRef(0);
  // Always the latest committed store, set synchronously in commit() so a
  // long-running connectTo reads current state instead of the snapshot it began
  // with (a forget/disconnect mid-race must not be reverted).
  const storeRef = useRef<DeviceStore>(store);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  /** Persist and hold in state together, so the two can never disagree. */
  const commit = useCallback(async (next: DeviceStore) => {
    storeRef.current = next;
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
  const connectTo = useCallback(async (
    device: SavedDevice,
    from: DeviceStore,
    opts?: { silent?: boolean },
  ): Promise<void> => {
    // Seed the latest-store ref from the caller's just-committed store, so the
    // final commit has a correct base even before React flushes the render.
    storeRef.current = from;
    const attempt = ++attemptRef.current;
    // A silent re-race (recovery after a roam) keeps the screen 'connected'
    // while it re-resolves in the background — flashing 'connecting' would blank
    // a stream that is, in fact, still on screen. A normal connect still shows
    // the spinner.
    if (!opts?.silent) setPhase('connecting');
    setTrustProblem(null);

    if (isUnresolved(device.token)) {
      // The keychain was unreadable when the store loaded (phone locked at a
      // protected-data launch), so this device still carries the marker, not a
      // real token. /health needs no auth and would answer, painting a
      // 'connected' computer whose every authed call then 401s — surfaced later
      // as the misleading "no longer paired". Treat it as unreachable now; the
      // next cold launch re-reads the keychain and resolves the token.
      setConn(null);
      clearClientConnection();
      setActiveUrl(null);
      setPhase('unreachable');
      return;
    }

    // Pin before the first packet: an https address only answers /health if
    // the native layer accepted the certificate this pairing recorded.
    const urls = device.addresses.map((a) => a.url);
    if (device.fingerprint) pinAddresses(urls, device.fingerprint);

    const ordered = orderAddresses(device.addresses, device.lastKnownGoodUrl);
    // The host answers plain HTTP on the LAN with a refusal that says why
    // (426, `plaintext-refused`). That is not "unreachable" — it is "pair
    // again" — and the race would otherwise flatten it into a dead probe.
    let plaintextRefused = false;
    const winner = await raceAddresses(ordered, async (url, signal) => {
      const health = await checkHost(url, signal);
      if (health.plaintextRefused) plaintextRefused = true;
      return { ok: health.ok, hostId: health.id };
    });

    // A newer attempt started while this one was in flight; its result wins.
    if (!mountedRef.current || attempt !== attemptRef.current) return;

    const refuse = (problem: TrustProblem | null) => {
      setConn(null);
      clearClientConnection();
      setActiveUrl(null);
      setTrustProblem(problem);
      // A real, actionable state — the computer is asleep, this network
      // cannot reach it, or it is not the machine we paired with — not
      // something to hide behind a spinner.
      setPhase('unreachable');
    };

    // A silent re-race that finds nothing leaves the connection in place: the
    // request that triggered it retries once more and fails honestly, and the
    // panel on screen shows its own "lost contact" state instead of being
    // unmounted by the (home) guard mid-render (#69). A plaintext refusal is
    // still a real verdict — that needs a new pairing, not a retry.
    if (!winner && opts?.silent && !plaintextRefused) return;
    if (!winner) { refuse(plaintextRefused ? 'needs-repair' : null); return; }

    // Something answered. Before the token goes anywhere: is it the computer
    // this pairing belongs to? A different (or absent) host id, a failed
    // proof, or a pairing too old to be verified on this link all stop here —
    // see devices/verify-host.ts.
    const trust = await verifyHost(
      { device, url: winner.url, reportedHostId: winner.hostId, pinEnforced: pinEnforced(winner.url, device.fingerprint) },
      challengeHost,
      randomBytes,
    );
    if (!mountedRef.current || attempt !== attemptRef.current) return;
    if (!trust.ok) { refuse(trust.problem); return; }

    const resolved: Connection = {
      host: winner.url,
      token: device.token,
      hostName: device.label,
      hostId: device.id,
    };
    setClientConnection(resolved);
    setConn(resolved);
    setActiveUrl(winner.url);
    setPhase('connected');

    // The current store, not the `from` snapshot captured before the race — a
    // concurrent forget/rename/disconnect must survive this commit.
    let next = recordSuccess(storeRef.current, device.id, winner.url, winner.rttMs, Date.now());
    // A computer carried over from the old single-connection layout has a
    // synthesised id; the first host that reports a real one lets it become an
    // ordinary entry, keeping its token.
    if (trust.adoptId) {
      next = adoptRealId(next, device.id, trust.adoptId);
    }
    await commit(next);
  }, [commit]);

  // Initial load: read the saved computers, then try to reach the active one.
  useEffect(() => {
    let live = true;
    loadStore()
      .then(async (loaded) => {
        if (!live) return;
        storeRef.current = loaded;
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
    // Only cancel an in-flight connect when we're forgetting the computer that
    // connect is actually talking to. Bumping the counter unconditionally also
    // cancels an in-flight connect to the *active* machine when a different,
    // non-active computer is forgotten — that connect then fails its own
    // attempt guard and returns without ever setting a phase, wedging the app
    // at 'connecting' forever (auto-reconnect waits out 'connecting', so it
    // never recovers either).
    if (wasActive) attemptRef.current += 1;
    // Revoke this phone's token on that computer first (best effort, short
    // deadline), so "un-paired from it" is true on both ends; an unreachable
    // or unverified host is still forgotten locally (#83). The live connection
    // already passed verifyHost; any other address must pass it now, exactly
    // as connectTo does, before the token is sent there.
    const next = await forgetDevice(store, id, (device) => {
      if (device.fingerprint) pinAddresses(device.addresses.map((a) => a.url), device.fingerprint);
      return revokeAtVerifiedHost(device, {
        connectedHost: connection?.hostId === device.id ? connection.host : null,
        checkHost: (url) => checkHost(url),
        verify: (input) => verifyHost({ ...input, pinEnforced: pinEnforced(input.url, input.device.fingerprint) }, challengeHost, randomBytes),
        revoke: revokeSelf,
      });
    });
    await commit(next);

    const stillActive = pickActive(next);
    if (!stillActive) {
      setConn(null);
      clearClientConnection();
      setActiveUrl(null);
      setTrustProblem(null);
      setPhase('idle');
      return;
    }
    // Only re-race when we just removed the computer we were talking to.
    if (wasActive) await connectTo(stillActive, next);
  }, [store, connection, commit, connectTo]);

  const rename = useCallback(async (id: string, label: string) => {
    attemptRef.current += 1; // don't let an in-flight connect revert the rename
    await commit(renameDevice(store, id, label));
  }, [store, commit]);

  const reconnect = useCallback(async () => {
    const device = pickActive(store);
    if (device) await connectTo(device, store);
  }, [store, connectTo]);

  // Silent recovery for the REST/input path. Registered with the api layer,
  // which calls it when a control request fails at the network layer (a roam
  // left the pinned address half-open). It re-races the active computer's
  // addresses and repoints the client — without disturbing the live stream —
  // so the retried request lands. Coalesced: a burst of failing requests share
  // one in-flight re-race rather than starting a stampede of them.
  const revalidatingRef = useRef<Promise<void> | null>(null);
  const revalidate = useCallback((): Promise<void> => {
    if (revalidatingRef.current) return revalidatingRef.current;
    const device = pickActive(storeRef.current);
    if (!device) return Promise.resolve();
    const run = connectTo(device, storeRef.current, { silent: true })
      .finally(() => { revalidatingRef.current = null; });
    revalidatingRef.current = run;
    return run;
  }, [connectTo]);

  useEffect(() => {
    setRecoveryHandler(revalidate);
    return () => setRecoveryHandler(null);
  }, [revalidate]);

  const disconnect = useCallback(async () => {
    attemptRef.current += 1; // cancel any in-flight connect before wiping state
    await commit(emptyStore());
    setConn(null);
    clearClientConnection();
    setActiveUrl(null);
    setTrustProblem(null);
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
    trustProblem,
    addDevice,
    switchTo,
    forget,
    rename,
    reconnect,
    disconnect,
  }), [
    ready, connection, store.devices, active, phase, activeUrl, trustProblem,
    addDevice, switchTo, forget, rename, reconnect, disconnect,
  ]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  return useContext(ConnectionContext);
}
