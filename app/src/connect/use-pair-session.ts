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
import { buildSavedDevice } from '../devices/from-host';
import type { SavedDevice } from '../devices/model';
import { haptic } from '../ui';
import type { Diagnosis } from './diagnose';
import { diagnosePairFailure } from './diagnose';
import { postPairDestination } from './landing';
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
}

export function usePairSession(addDevice: (device: SavedDevice) => Promise<void>): PairSession {
  const [stage, setStage] = useState<Stage>('welcome');
  const [host, setHost] = useState<HostSummary | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [hostError, setHostError] = useState<Diagnosis | null>(null);
  const [pairError, setPairError] = useState<Diagnosis | null>(null);

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
  const completePairing = useCallback(async (hostUrl: string, pairingCode: string) => {
    try {
      const result = await pair(hostUrl, pairingCode, deviceNameFor(Platform.OS));
      // Re-read /health now that we are paired, so the saved computer gets the
      // host's real identity and its full address list rather than just the one
      // URL that happened to be typed in.
      const identity = await checkHost(result.host);
      const device = buildSavedDevice(result, identity, Date.now());
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
    } catch (e: unknown) {
      haptic('error');
      setStage('code');
      setPairError(diagnosePairFailure(hostUrl, errorMessage(e)));
      setCode('');
    }
  }, [addDevice]);

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
      const reachable = await firstReachable(link.addresses, checkHost);
      if (!reachable) {
        setStage('host');
        setHostError({
          title: `Could not reach ${link.label}`,
          message:
            'The code scanned fine, but none of that computer\'s addresses answered ' +
            'from this network. Check it is awake and on the same Wi-Fi, or use Tailscale.',
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
  };
}
