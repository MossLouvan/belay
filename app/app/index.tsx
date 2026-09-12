// Connect screen — the first thing anyone sees, and the only place the app can
// lose someone entirely.
//
// The front door is the address field: copy the computer's 100.x address out
// of the Tailscale app, type it, Connect — over the tailnet that pairs with no
// code at all. On home Wi-Fi the 6-digit code shown on the computer follows.
// Around those steps sits the onboarding a cold start needs: what has to be
// running, where the address is, and what to do when it fails. A saved
// connection skips the whole thing.
//
// This file is composition only. The pairing state machine is
// src/connect/use-pair-session.ts, the address check and everything it
// leaves behind is src/connect/use-address-check.ts, the scrolling steps are
// src/connect/pairing-stages.tsx, and the pure pieces are
// src/connect/pair-flow.ts. Sibling files inside app/ would register as
// routes, which is why none of it lives here.

import React, { useCallback, useEffect } from 'react';
import { Animated } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useConnection } from '../src/connection';
import { useTheme } from '../src/theme';
import { KeyboardAvoider } from '../src/ui';
import { connectLanding, afterHowItWorks } from '../src/connect/landing';
import { PairingStages } from '../src/connect/pairing-stages';
import { TailscaleGuide } from '../src/connect/tailscale-guide';
import { HowItWorksScreen, WelcomeScreen } from '../src/connect/setup-intro';
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

  const session = usePairSession(addDevice);
  const check = useAddressCheck({ session, adding, scanRequested: scan === '1', arrivedAddress });
  const { stage, setStage, busy, setBusy, live, completePairing } = session;
  const { fadeAnim, transitionToStage } = useStageFade(setStage);

  // Already set up from a previous launch. One reachable computer goes straight
  // in; anything else lands on the computer list, which is the only screen that
  // can explain "your Mac did not answer" and offer somewhere to go next.
  // Unless the user came here on purpose to pair another machine — the
  // decision itself lives in connect/landing.ts, where node can test it.
  useEffect(() => {
    const dest = connectLanding({
      ready,
      connected: connection !== null,
      deviceCount: devices.length,
      connecting: phase === 'connecting',
      adding,
    });
    if (dest) router.replace(dest);
  }, [ready, connection, devices.length, phase, adding]);

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

  const onWelcomeContinue = useCallback(() => {
    transitionToStage('how-it-works');
  }, [transitionToStage]);

  /**
   * After "how it works" comes the address field — the owner's own route in
   * is copying the 100.x address out of the Tailscale app, so that is what
   * the screen leads with. The guided Tailscale setup stays one tap away on
   * that screen for anyone who has no address to copy yet. The decision
   * itself lives in connect/landing.ts, where node can test it.
   */
  const onHowItWorksContinue = useCallback(() => {
    const next = afterHowItWorks(check.recent.length > 0);
    if (next === 'tailscale') check.setGuideHost(null);
    transitionToStage(next);
  }, [check.recent.length, check.setGuideHost, transitionToStage]);

  const onHowItWorksBack = useCallback(() => {
    transitionToStage('welcome');
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
          <WelcomeScreen onContinue={onWelcomeContinue} />
        ) : stage === 'how-it-works' ? (
          <HowItWorksScreen onContinue={onHowItWorksContinue} onBack={onHowItWorksBack} />
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
