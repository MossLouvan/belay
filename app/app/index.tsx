// Connect screen — the first thing anyone sees, and the only place the app can
// lose someone entirely.
//
// A fresh, signed-in install lands on "Put Belay on your computer": open
// Belay there and scan its QR (app/link.tsx), which links the computer to the
// account and pairs it through the tunnel. Connecting by address (a local IP,
// or a VPN address such as Tailscale's) is the advanced door, and every
// later step of that legacy path still lives here: the address field, the
// scanner, the 6-digit code. A saved connection skips the whole thing.
//
// This file is composition only. The pairing state machine is
// src/connect/use-pair-session.ts, the address check and everything it
// leaves behind is src/connect/use-address-check.ts, the scrolling steps are
// src/connect/pairing-stages.tsx, and the pure pieces are
// src/connect/pair-flow.ts. Sibling files inside app/ would register as
// routes, which is why none of it lives here.

import React, { useCallback, useEffect, useMemo } from 'react';
import { Animated } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useConnection } from '../src/connection';
import { useAccount } from '../src/account/store';
import { signInRequired } from '../src/account/gate';
import { mergeComputers } from '../src/account/merge-devices';
import { tunnelIntentFor } from '../src/account/tunnel-intent';
import { useTheme } from '../src/theme';
import { KeyboardAvoider } from '../src/ui';
import { connectLanding } from '../src/connect/landing';
import { PairingStages } from '../src/connect/pairing-stages';
import { TailscaleGuide } from '../src/connect/tailscale-guide';
import { WelcomeScreen } from '../src/connect/setup-intro';
import { useAddressCheck } from '../src/connect/use-address-check';
import { usePairSession } from '../src/connect/use-pair-session';
import { useStageFade } from '../src/connect/use-stage-fade';

export default function Connect() {
  const { ready, connection, addDevice, devices, phase } = useConnection();
  const theme = useTheme();
  // Set by "Add a computer": the redirect below must stand down, or the
  // button that led here just bounces its user straight back. The computer
  // list's own address field arrives with `address` already typed (checked
  // on arrival), or with `scan` when it asked for the scanner.
  const { add, address, scan } = useLocalSearchParams<{ add?: string; address?: string; scan?: string }>();
  const adding = add === '1';
  const arrivedAddress = typeof address === 'string' && address.trim() ? address : null;
  const { ready: accountReady, account, devices: accountDevices } = useAccount();
  // A linked computer being paired through the tunnel: the address is a
  // loopback port, and the saved computer must carry the node id instead.
  // Read from memory, never the URL (account/tunnel-intent.ts), and only for
  // the exact port startPairingOverTunnel dialled, for a node on the account.
  const tunnel = useMemo(() => tunnelIntentFor(arrivedAddress, accountDevices.map((d) => d.nodeId)), [arrivedAddress, accountDevices]);
  const tunnelNode = tunnel?.nodeId ?? null;
  // A computer linked to the account but not paired here yet still belongs on
  // the list (its Pair button), not back on "put Belay on your computer".
  const linkedOnly = mergeComputers(devices, accountDevices).linkedOnly.length;
  const session = usePairSession(addDevice, tunnelNode, tunnel?.trust === true);
  const check = useAddressCheck({ session, adding, scanRequested: scan === '1', arrivedAddress });
  const { stage, setStage, busy, setBusy, live, completePairing } = session;
  const { fadeAnim, transitionToStage } = useStageFade(setStage);

  // Already set up from a previous launch. One reachable computer goes straight
  // in; anything else lands on the computer list, which is the only screen that
  // can explain "your Mac did not answer" and offer somewhere to go next.
  // Unless the user came here on purpose to pair another machine — the
  // decision itself lives in connect/landing.ts, where node can test it.
  useEffect(() => {
    // Accounts are required for anything new (account/gate.ts): a fresh
    // install, or an already-paired phone adding another computer. Existing
    // pairings keep working signed out.
    if (signInRequired({ ready: ready && accountReady, signedIn: account !== null, deviceCount: devices.length, adding })) {
      router.replace(adding ? '/sign-in?next=/?add=1' : '/sign-in');
      return;
    }
    const dest = connectLanding({
      ready,
      connected: connection !== null,
      deviceCount: devices.length + linkedOnly,
      connecting: phase === 'connecting',
      adding,
    });
    if (dest) router.replace(dest);
  }, [ready, accountReady, account, connection, devices.length, linkedOnly, phase, adding]);

  /** The guide detected the tailnet: pair over the address it discovered. */
  const onGuideConnected = useCallback(
    (url: string) => {
      void (async () => {
        setBusy(true);
        try {
          await completePairing(url, '');
        } finally {
          if (live.current) setBusy(false);
        }
      })();
    },
    [completePairing, live, setBusy],
  );

  /**
   * The guide's escape hatch back to the six digits. The compact Tailscale
   * card is cleared first — someone who chose the code does not need the same
   * advice repeated above the boxes.
   */
  const onGuideUseCode = useCallback(() => {
    check.clearTailscaleNotes();
    transitionToStage('code');
  }, [check.clearTailscaleNotes, transitionToStage]);

  const onGuideClose = useCallback(() => {
    check.clearTailscaleNotes();
    check.setGuideHost(null);
    transitionToStage('host');
  }, [check.clearTailscaleNotes, check.setGuideHost, transitionToStage]);

  const onGuideScan = useCallback(() => {
    transitionToStage('scan');
  }, [transitionToStage]);

  /** The cold guide's ending: Tailscale is up, now type the address it shows. */
  const onGuideTypeAddress = useCallback(() => {
    check.setGuideHost(null);
    transitionToStage('host');
  }, [check.setGuideHost, transitionToStage]);

  /** "Connect from anywhere" opened cold — no computer to watch for yet. */
  const onOpenGuide = useCallback(() => {
    check.setGuideHost(null);
    transitionToStage('tailscale');
  }, [check.setGuideHost, transitionToStage]);

  /** The account way in: the claim QR (or its typed code) on app/link.tsx. */
  const onWelcomeLink = useCallback(() => {
    router.push('/link');
  }, []);

  /** Advanced: the legacy address field, for a LAN or VPN address. */
  const onWelcomeAdvanced = useCallback(() => {
    transitionToStage('host');
  }, [transitionToStage]);

  return (
    // The front door has to survive the keyboard it opens with: the address
    // field autofocuses, so Connect — and on the next step Pair, under six
    // digit boxes and a paragraph — start life below the keys. The avoider
    // measures in window coordinates instead of KeyboardAvoidingView's
    // parent-relative guess, and unlike it does something on Android too.
    <KeyboardAvoider style={{ backgroundColor: theme.colors.bg }}>
      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        {stage === 'welcome' ? (
          <WelcomeScreen onLink={onWelcomeLink} onAdvanced={onWelcomeAdvanced} />
        ) : stage === 'tailscale' ? (
          <TailscaleGuide
            host={check.guideHost}
            detail={check.tailscaleDetail}
            busy={busy}
            onConnected={onGuideConnected}
            onUseCode={check.guideHost ? onGuideUseCode : undefined}
            onScan={onGuideScan}
            onTypeAddress={onGuideTypeAddress}
            onClose={onGuideClose}
          />
        ) : (
          <PairingStages session={session} check={check} adding={adding} onOpenGuide={onOpenGuide} />
        )}
      </Animated.View>
    </KeyboardAvoider>
  );
}
