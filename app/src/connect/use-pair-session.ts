// The pairing state machine: which stage is up, which host it is about, the
// six digits, and the one path that trades a code for a token and saves the
// computer. Shared by the typed flow, the scanned one and the Tailscale
// guide so the three cannot drift.
//
// The address check that leads here lives in use-address-check.ts; the pure
// helpers in pair-flow.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { checkHost, pair } from '../api';
import type { PairResult } from '../api';
import { askToJoin, waitForApproval } from '../account/account-pair';
import { clearTunnelIntent } from '../account/tunnel-intent';
import { buildSavedDevice } from '../devices/from-host';
import { pinAddresses, pinnedFingerprint } from '../devices/pinning';
import type { SavedDevice } from '../devices/model';
import { savedOverTunnel } from '../devices/tunnel-candidate';
import { haptic } from '../ui';
import type { Diagnosis } from './diagnose';
import { diagnosePairFailure } from './diagnose';
import { postPairDestination } from './landing';
import { localNetworkDiagnosis, primeLocalNetwork } from './local-network-permission';
import type { ParsedPairLink } from './pair-link';
import { CODE_LENGTH } from './pair-step';
import type { HostSummary } from './pair-step';
import { SUCCESS_DWELL_MS, deviceNameFor, errorMessage, firstReachable } from './pair-flow';
import type { Stage } from './pair-flow';

export interface PairSession {
  readonly stage: Stage;
  readonly setStage: (next: Stage) => void;
  readonly host: HostSummary | null;
  readonly setHost: (next: HostSummary | null) => void;
  readonly code: string;
  readonly setCode: (next: string) => void;
  readonly busy: boolean;
  readonly setBusy: (next: boolean) => void;
  readonly hostError: Diagnosis | null;
  readonly setHostError: (next: Diagnosis | null) => void;
  readonly pairError: Diagnosis | null;
  readonly setPairError: (next: Diagnosis | null) => void;
  /** False once the screen is gone, so a late `/health` cannot set state. */
  readonly live: RefObject<boolean>;
  /** Trade a code for a token and save the computer. */
  readonly completePairing: (hostUrl: string, pairingCode: string) => Promise<void>;
  /** The code screen's submit. */
  readonly doPair: () => Promise<void>;
  /** A scanned link: race its addresses, then pair with the code it carries. */
  readonly onScanned: (link: ParsedPairLink) => Promise<void>;
  readonly onChangeCode: (next: string) => void;
  /**
   * Account trust for a computer reached over the tunnel: pair with no code
   * (first phone) or wait for one tap. False when this computer does not do
   * account trust for this phone, so the caller falls back to the code.
   */
  readonly tryAccountPairing: (hostUrl: string, hostNodeId: string | undefined) => Promise<boolean>;
  /** Cancel on the "Waiting for approval…" screen. */
  readonly cancelApproval: () => void;
  /** Why the last wait ended without a pairing (declined, expired), else null. */
  readonly approvalError: Diagnosis | null;
  /** The code the computer's prompt shows too, while waiting. */
  readonly matchCode: string;
}

/**
 * `tunnelNodeId` is set when the computer is being paired THROUGH the
 * tunnel (a linked computer): the saved entry then carries that node id and
 * not the loopback port it was paired on. `accountTrust` (auto-pair.ts) asks
 * the host's POST /pair/account before ever showing a code.
 */
export function usePairSession(
  addDevice: (device: SavedDevice) => Promise<void>,
  tunnelNodeId: string | null = null,
  accountTrust = false,
): PairSession {
  const [stage, setStage] = useState<Stage>('welcome');
  const [host, setHost] = useState<HostSummary | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [hostError, setHostError] = useState<Diagnosis | null>(null);
  const [pairError, setPairError] = useState<Diagnosis | null>(null);

  const [approvalError, setApprovalError] = useState<Diagnosis | null>(null);
  const [matchCode, setMatchCode] = useState('');
  const approvalAbort = useRef<AbortController | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current);
    approvalAbort.current?.abort();
  }, []);

  const onChangeCode = useCallback((next: string) => {
    setCode(next);
    setPairError(null);
  }, []);

  /**
   * Trade a code for a token and save the computer.
   *
   * Shared by the typed flow and the scanned one so the two cannot drift —
   * scanning must produce exactly the same saved computer as typing, including
   * the identity re-read below.
   */
  /** A token in hand: check it, re-read the host, save it and go in. */
  const finishPairing = useCallback(async (hostUrl: string, result: PairResult) => {
    // The host names its certificate in the reply; it must be the one this
    // address was pinned to (from the QR, or the fingerprint shown for a
    // typed address). Anything else means the pairing went somewhere else.
    const pinned = pinnedFingerprint(hostUrl);
    if (pinned && result.fingerprint && result.fingerprint !== pinned) {
      throw new Error('the computer\'s certificate does not match the one this phone was shown');
    }
    // Pin the fingerprint for every address the host advertises before the
    // identity re-read below and every connect after it.
    if (result.fingerprint) pinAddresses([hostUrl], result.fingerprint);
    // Re-read /health now that we are paired, so the saved computer gets the
    // host's real identity and its full address list rather than just the one
    // URL that happened to be typed in.
    const identity = await checkHost(result.host);
    if (result.fingerprint) pinAddresses((identity.addresses ?? []).map((a) => a.url), result.fingerprint);
    const built = buildSavedDevice(result, identity, Date.now());
    const device = tunnelNodeId ? savedOverTunnel(built, tunnelNodeId) : built;
    haptic('success');
    setStage('success');
    successTimer.current = setTimeout(() => {
      // Save and connect *before* navigating. The tabs guard redirects away
      // when there is no live connection, so leaving this unawaited bounces
      // the user straight back to this screen. Land on a tab that actually
      // works: a Mac without the capture permission would otherwise open on a
      // black Screen tab as its first impression (postPairDestination).
      void addDevice(device).then(() => router.replace(postPairDestination(identity.native)));
    }, SUCCESS_DWELL_MS);
  }, [addDevice, tunnelNodeId]);

  const completePairing = useCallback(async (hostUrl: string, pairingCode: string) => {
    try {
      await finishPairing(hostUrl, await pair(hostUrl, pairingCode, deviceNameFor(Platform.OS)));
    } catch (e: unknown) {
      haptic('error');
      setStage('code');
      setPairError(diagnosePairFailure(hostUrl, errorMessage(e)));
      setCode('');
    } finally {
      // The dial is spent either way (account/tunnel-intent.ts).
      clearTunnelIntent();
    }
  }, [finishPairing]);

  const tryAccountPairing = useCallback(async (hostUrl: string, hostNodeId: string | undefined): Promise<boolean> => {
    if (!tunnelNodeId || !accountTrust) return false;
    setApprovalError(null);
    setMatchCode('');
    try {
      // The tunnel authenticates the node it dialled; the host must agree it
      // is that node, or this is not the computer the account named.
      if (hostNodeId !== tunnelNodeId) throw new Error('the computer that answered is not the one linked to your account');
      const start = await askToJoin(hostUrl, deviceNameFor(Platform.OS));
      if (start.kind === 'unsupported') return false;
      if (start.kind === 'error') throw new Error(start.message);
      if (start.kind === 'paired') { await finishPairing(hostUrl, start.result); return true; }
      setMatchCode(start.matchCode);
      setStage('approval');
      const abort = new AbortController();
      approvalAbort.current = abort;
      const end = await waitForApproval(hostUrl, start, { signal: abort.signal });
      approvalAbort.current = null;
      if (!live.current) return true;
      if (end.kind === 'paired') await finishPairing(hostUrl, end.result);
      else if (end.kind === 'denied') setApprovalError({ title: 'Not allowed', message: 'Someone declined this phone on your computer or another phone. Ask again if that was a mistake.' });
      else if (end.kind === 'expired') setApprovalError({ title: 'Nobody answered in time', message: 'The request lapsed after five minutes. Ask again, then tap Allow on your computer or another phone.' });
      return true;
    } catch (e: unknown) {
      haptic('error');
      setStage('approval');
      setApprovalError({ title: 'Could not add this phone', message: errorMessage(e) });
      return true;
    } finally {
      clearTunnelIntent();
    }
  }, [finishPairing, tunnelNodeId, accountTrust]);

  const cancelApproval = useCallback(() => {
    approvalAbort.current?.abort();
    approvalAbort.current = null;
    router.back();
  }, []);

  const doPair = useCallback(async () => {
    if (!host) return;
    setPairError(null);
    if (code.length !== CODE_LENGTH) {
      setPairError({
        title: `Enter all ${CODE_LENGTH} digits`,
        message: 'The pairing code shown on your computer is six digits long.',
      });
      return;
    }

    setBusy(true);
    try {
      await completePairing(host.url, code);
    } finally {
      setBusy(false);
    }
  }, [host, code, completePairing]);

  /**
   * A scanned link carries the address and the code together, so there is
   * nothing left to type. The addresses are raced rather than assumed: the QR
   * lists every path the host knows, and only one of them is reachable from
   * wherever the phone happens to be standing.
   */
  const onScanned = useCallback(async (link: ParsedPairLink) => {
    setPairError(null);
    setBusy(true);
    try {
      // The QR carried the host's certificate fingerprint: pin it for every
      // address before the first probe, so an https address only answers if it
      // presents that certificate.
      if (link.fingerprint) pinAddresses(link.addresses, link.fingerprint);
      await primeLocalNetwork(link.addresses);
      const reachable = await firstReachable(link.addresses, checkHost);
      if (!reachable) {
        const blocked = await localNetworkDiagnosis(link.addresses);
        setStage('host');
        setHostError(blocked ?? {
          title: `Could not reach ${link.label}`,
          message:
            'The code scanned fine, but none of that computer\'s addresses answered ' +
            'from this network. Make sure Belay is open on the computer and it is awake, or go back and scan the QR code Belay shows to link it to your account.',
        });
        return;
      }
      // Both outcome screens are gated on `host` (`stage === 'code' && host`,
      // `stage === 'success' && host`), so it must be set before the attempt.
      // Without it a failed pair — routine, since codes are single-use and
      // rotate — set the stage but rendered neither branch, stranding the user
      // on a blank screen with no error and no way back.
      setHost({
        url: reachable,
        name: link.label,
        // The link does not carry these; assume capable and unpaired, the same
        // benefit of the doubt `doCheck` gives an older host. Both only shape
        // advisory notes on the code screen, and the post-pair /health re-read
        // saves the computer with its real capabilities regardless.
        native: true,
        paired: false,
      });
      await completePairing(reachable, link.code);
    } finally {
      setBusy(false);
    }
  }, [completePairing]);

  return {
    stage, setStage,
    host, setHost,
    code, setCode,
    busy, setBusy,
    hostError, setHostError,
    pairError, setPairError,
    live,
    completePairing,
    doPair,
    onScanned,
    onChangeCode,
    tryAccountPairing,
    cancelApproval,
    approvalError,
    matchCode,
  };
}
