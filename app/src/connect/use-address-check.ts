// The address field's brain: check one address, decide what pairing it
// allows, and carry the state that decision leaves behind — the Tailscale
// card, the guide's host, the dead-end notice, the remembered computers.
//
// Everything that moves the pairing forward (the stage, the host, the code)
// is written into the session from use-pair-session.ts; this hook only
// decides. The pure helpers are in pair-flow.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { checkHost } from '../api';
import { haptic } from '../ui';
import type { PairingDeadEnd } from './dead-end';
import { detectDeadEnd } from './dead-end';
import type { Diagnosis } from './diagnose';
import { diagnoseHostFailure } from './diagnose';
import { forgetHost, loadRecentHosts, prettyHost, rememberHost, resolveHost } from './host-input';
import type { TailnetOutcome } from './tailnet';
import { TAILNET_PROBE_ATTEMPTS, planTailnetUpgrade, readTailnetProbe, tailnetUrlFrom } from './tailnet';
import type { GuideHost } from './tailscale-guide';
import type { DiscoveredShortcut } from './address-entry';
import { HOST_CHECK_TIMEOUT_MS, TIMED_OUT, withDeadline } from './pair-flow';
import type { DeadEndNotice, HealthResult } from './pair-flow';
import { useTailnetDiscovery } from './use-tailnet-discovery';
import { useTailscaleReturn } from './use-tailscale-return';
import type { PairSession } from './use-pair-session';

export interface AddressCheckInputs {
  readonly session: PairSession;
  /** The user came to pair another computer on purpose (the `add` param). */
  readonly adding: boolean;
  /** The computer list asked for the scanner (`scan=1`). */
  readonly scanRequested: boolean;
  /** An address handed over by the computer list, checked once on arrival. */
  readonly arrivedAddress: string | null;
}

export interface AddressCheck {
  readonly hostText: string;
  readonly setHostText: (next: string) => void;
  readonly recent: readonly string[];
  /** The remembered computer answering over the tailnet right now, as one tap. */
  readonly discovered: DiscoveredShortcut | null;
  /** Set when the host answered but its tailnet address did not; the host's name. */
  readonly tailscaleOff: string | null;
  /** The last tailnet failure, shown on the card so a stuck setup is diagnosable. */
  readonly tailscaleDetail: string | null;
  /** The computer the Tailscale guide watches for; null when opened cold. */
  readonly guideHost: GuideHost | null;
  readonly setGuideHost: (next: GuideHost | null) => void;
  readonly deadEnd: DeadEndNotice | null;
  /** True while a `/health` check is in flight. */
  readonly checking: RefObject<boolean>;
  /** Clear the compact Tailscale card (its name and detail). */
  readonly clearTailscaleNotes: () => void;
  /** Note that Tailscale was just opened, so the next foreground re-checks. */
  readonly armTailscaleReturn: () => void;
  readonly checkAddress: (text: string) => Promise<void>;
  /** The field's own submit: check what is typed. */
  readonly doCheck: () => Promise<void>;
  readonly onChangeHost: (next: string) => void;
  readonly onBack: () => void;
  readonly onRetryTailscale: () => void;
  readonly onPickRecent: (url: string) => void;
  readonly onForgetRecent: (url: string) => void;
}

const checkHostBounded = (url: string): Promise<HealthResult> =>
  withDeadline(checkHost(url), HOST_CHECK_TIMEOUT_MS, TIMED_OUT);

export function useAddressCheck({ session, adding, scanRequested, arrivedAddress }: AddressCheckInputs): AddressCheck {
  const {
    stage, setStage, setHost, setCode, setBusy, setHostError, setPairError, live, completePairing, onScanned,
  } = session;

  const [hostText, setHostText] = useState(arrivedAddress ?? '');
  const [recent, setRecent] = useState<readonly string[]>([]);
  /**
   * Set when the computer answered but its tailnet address did not, which means
   * Tailscale is off on this phone rather than anything being wrong with the
   * host. Carries the host's name so the card can say which computer is waiting.
   */
  const [tailscaleOff, setTailscaleOff] = useState<string | null>(null);
  const [tailscaleDetail, setTailscaleDetail] = useState<string | null>(null);
  /**
   * The computer the Tailscale guide watches for. Set alongside the guide
   * stage when a host answered but its tailnet address did not; null when the
   * guide was opened cold from the connect screen (no computer to watch yet),
   * in which case the guide ends back at the address field instead of
   * auto-detecting.
   */
  const [guideHost, setGuideHost] = useState<GuideHost | null>(null);
  /**
   * Set when the code screen would be a trap: the host is already paired and
   * requires a code from this connection, but a paired host never issues one.
   * Carries what the check saw so the notice can state observation, not guess,
   * and a timestamp for the proof-of-life stamp (docs/DESIGN.md §11.4).
   */
  const [deadEnd, setDeadEnd] = useState<DeadEndNotice | null>(null);

  /** True while a `/health` check is in flight — blocks a second, overlapping one. */
  const checking = useRef(false);
  /** Identifies the newest check, so only its result may be applied. */
  const checkSeq = useRef(0);
  /** An address handed over by the computer list is checked once, on arrival. */
  const pendingArrival = useRef(arrivedAddress);
  // A remembered computer that answers over the tailnet right now is offered
  // above the field as one tap — the field itself stays regardless.
  const discoveredHost = useTailnetDiscovery(recent, stage === 'host' && !adding);

  useEffect(() => {
    let alive = true;
    loadRecentHosts().then((list) => {
      if (!alive) return;
      setRecent(list);
      // Skip intro screens if user has connected before (has recent hosts),
      // or came from the computer list to add another. First-time users see
      // welcome → how it works → connect.
      if (list.length > 0 || adding) {
        setStage(scanRequested ? 'scan' : 'host');
      }
      // Pre-fill the last computer used, so the common case is one tap — but
      // not when adding another: the most recent host is by definition the
      // machine already paired, the one address that cannot be the answer.
      if (!adding && list.length > 0) setHostText((current) => current || prettyHost(list[0]));
    });
    return () => {
      alive = false;
    };
  }, [adding, scanRequested, setStage]);

  const clearTailscaleNotes = useCallback(() => {
    setTailscaleOff(null);
    setTailscaleDetail(null);
  }, []);

  const onChangeHost = useCallback((next: string) => {
    setHostText(next);
    setHostError(null);
    setTailscaleOff(null);
    setTailscaleDetail(null);
    setDeadEnd(null);
  }, [setHostError]);

  /**
   * Check one address and move on to whatever pairing it allows.
   *
   * Takes the text explicitly rather than reading the field, so the tailnet
   * shortcut and an address handed over by the computer list can check
   * without a render in between.
   */
  const checkAddress = useCallback(async (text: string) => {
    // A second submit while the first is still out (double Enter, a fast
    // double-tap, anything programmatic) would start a competing request whose
    // result could land last and overwrite the newer one.
    if (checking.current) return;

    setHostError(null);
    setDeadEnd(null);
    const resolved = resolveHost(text);

    // Paste-to-pair: detect pasted belay://pair?... or tether: links.
    if (resolved.ok === 'pair-link') {
      await onScanned(resolved.link);
      return;
    }

    if (!resolved.ok) {
      setHostError({ title: 'Check the address', message: resolved.reason });
      return;
    }

    checking.current = true;
    const seq = checkSeq.current + 1;
    checkSeq.current = seq;
    setBusy(true);
    try {
      const result = await checkHostBounded(resolved.url);
      // Apply nothing from a superseded check, and nothing at all once the
      // screen is gone (the already-paired redirect can unmount mid-flight).
      if (!live.current || seq !== checkSeq.current) return;
      setBusy(false);

      if (!result.ok) {
        setHostError(diagnoseHostFailure(resolved.url, result.error));
        return;
      }

      haptic('success');
      setHost({
        url: resolved.url,
        name: result.name || 'your computer',
        // An older host that omits the flag is assumed capable — better than
        // warning about a limitation that may not exist.
        native: result.native !== false,
        paired: Boolean(result.paired),
      });
      setCode('');
      setPairError(null);

      // Over the owner's own tailnet the host has already verified this phone
      // and will pair without a code: go straight there. If that somehow fails
      // the normal code screen is the fallback, so nothing is lost by trying.
      //
      // When the check landed on a LAN address the host cannot recognise the
      // phone, even though the same phone reaching the same host over Tailscale
      // would pair with no code. The tailnet address is in the reply, so try it
      // rather than making anyone read a 100.x address off another screen.
      const plan = planTailnetUpgrade(result, resolved.url);

      // Run at every landing on stage 'code': the code screen is only honest
      // work while the host will actually issue a code, and an already-paired
      // host never does. Walking in blind is the exact hour-long trap the
      // dead-end notice exists to prevent.
      const flagDeadEnd = (probe: TailnetOutcome | null): boolean => {
        const dead: PairingDeadEnd | null = detectDeadEnd(result, plan, probe, tailnetUrlFrom(result));
        if (!dead) return false;
        setDeadEnd({ ...dead, checkedAt: Date.now(), platform: result.platform });
        return true;
      };

      if (plan.kind === 'ready' || plan.kind === 'upgrade') {
        const url = plan.kind === 'upgrade' ? plan.url : resolved.url;
        if (plan.kind === 'upgrade') {
          setBusy(true);
          // Retry rather than trust one deadline: the first packet over a cold
          // tailnet waits for the peers to find each other through a relay, and
          // that can outlast a single request on a link that then works fine.
          // One timeout is not evidence that Tailscale is off.
          let outcome = readTailnetProbe(url, { ok: false, error: 'not tried' });
          for (let attempt = 0; attempt < TAILNET_PROBE_ATTEMPTS; attempt += 1) {
            const probe = await checkHostBounded(url);
            if (!live.current || seq !== checkSeq.current) return;
            outcome = readTailnetProbe(url, probe);
            if (outcome.kind !== 'tailscale-off') break;
          }
          setBusy(false);

          if (outcome.kind === 'tailscale-off') {
            // When the host is also already paired, the dead-end notice owns
            // the Tailscale advice — showing both would be two notices making
            // the same point with two accent buttons.
            if (!flagDeadEnd(outcome)) {
              setTailscaleOff(result.name || 'Your computer');
              setTailscaleDetail(outcome.detail ?? null);
              // The guided climb, not the code screen: it watches for the
              // tailnet on its own and hands back the discovered address, so
              // nobody types a port or a 100.x. The code screen survives as
              // the guide's own escape hatch.
              setGuideHost({ url: resolved.url, name: result.name || 'your computer' });
              setStage('tailscale');
              return;
            }
            setStage('code');
            return;
          }
          if (outcome.kind === 'code-required') {
            flagDeadEnd(outcome);
            setStage('code');
            return;
          }
        }

        setBusy(true);
        try { await completePairing(url, ''); } finally { if (live.current) setBusy(false); }
        return;
      }
      flagDeadEnd(null);
      setStage('code');
      rememberHost(resolved.url).then(
        (list) => {
          if (live.current) setRecent(list);
        },
        () => undefined,
      );
    } finally {
      checking.current = false;
    }
  }, [live, onScanned, completePairing, setBusy, setCode, setHost, setHostError, setPairError, setStage]);

  /** The field's own submit: check what is typed. */
  const doCheck = useCallback(() => checkAddress(hostText), [checkAddress, hostText]);

  // The computer list's field hands its text over in the URL; check it the
  // moment the step is up, so that Connect there is the same tap as here.
  useEffect(() => {
    if (stage !== 'host' || !pendingArrival.current) return;
    const text = pendingArrival.current;
    pendingArrival.current = null;
    void checkAddress(text);
  }, [stage, checkAddress]);

  const onBack = useCallback(() => {
    setStage('host');
    setPairError(null);
    setCode('');
    setTailscaleOff(null);
    setTailscaleDetail(null);
    setDeadEnd(null);
  }, [setStage, setPairError, setCode]);

  /**
   * Re-run the whole check after the user turns Tailscale on.
   *
   * Deliberately the same path as the first attempt rather than a direct retry
   * of the tailnet address: with Tailscale up the host's reply may now name
   * addresses it could not before, so the upgrade decides again from scratch.
   */
  const onRetryTailscale = useCallback(() => {
    setTailscaleOff(null);
    setTailscaleDetail(null);
    setDeadEnd(null);
    setStage('host');
    setCode('');
    setPairError(null);
    void doCheck();
  }, [doCheck, setStage, setCode, setPairError]);

  const { armReturn: armTailscaleReturn } = useTailscaleReturn({
    stage,
    checking,
    live,
    onReturn: onRetryTailscale,
  });

  const onPickRecent = useCallback((url: string) => {
    setHostText(prettyHost(url));
    setHostError(null);
  }, [setHostError]);

  /** The tailnet shortcut: the remembered computer that is answering now. */
  const discovered = useMemo<DiscoveredShortcut | null>(
    () =>
      discoveredHost
        ? {
            name: discoveredHost.name,
            url: discoveredHost.url,
            onConnect: () => {
              setHostText(prettyHost(discoveredHost.url));
              void checkAddress(discoveredHost.url);
            },
          }
        : null,
    [discoveredHost, checkAddress],
  );

  const onForgetRecent = useCallback((url: string) => {
    forgetHost(url).then(setRecent, () => undefined);
  }, []);

  return {
    hostText, setHostText,
    recent,
    discovered,
    tailscaleOff, tailscaleDetail,
    guideHost, setGuideHost,
    deadEnd,
    checking,
    clearTailscaleNotes,
    armTailscaleReturn,
    checkAddress,
    doCheck,
    onChangeHost,
    onBack,
    onRetryTailscale,
    onPickRecent,
    onForgetRecent,
  };
}
