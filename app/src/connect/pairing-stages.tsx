// The scrolling pairing steps: the brand block, then whichever of the
// address field, the scanner, the code entry or the success receipt the
// session is on. The intro and the Tailscale guide are full-screen surfaces
// of their own and render outside this (app/index.tsx).
//
// Presentational: every decision comes in through the two hook results.

import React from 'react';
import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Button, Rule } from '../ui';
import { Brand } from './brand';
import { HostStep } from './host-step';
import { NoCodeStep } from './no-code-step';
import { AwayFromHomeNote, SetupSteps } from './onboarding';
import { PairStep } from './pair-step';
import { ScanStep } from './scan';
import { SuccessNotice } from './success-notice';
import { TailscaleStep } from './tailscale-card';
import type { AddressCheck } from './use-address-check';
import type { PairSession } from './use-pair-session';

export interface PairingStagesProps {
  readonly session: PairSession;
  readonly check: AddressCheck;
  /** The user came to pair another computer on purpose (the `add` param). */
  readonly adding: boolean;
  /** "Connect from anywhere" opened cold — no computer to watch for yet. */
  readonly onOpenGuide: () => void;
}

export function PairingStages({ session, check, adding, onOpenGuide }: PairingStagesProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { stage, setStage, host, code, busy, hostError, pairError } = session;

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: theme.layout.margin,
        paddingTop: insets.top + theme.space.lg,
        paddingBottom: insets.bottom + theme.space.xl,
        gap: theme.space.lg,
        flexGrow: 1,
        justifyContent: 'center',
        width: '100%',
        maxWidth: theme.layout.contentMaxWidth,
        alignSelf: 'center',
      }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      bounces={false}
      alwaysBounceVertical={false}
    >
      <Brand />

      {stage === 'host' ? (
        <>
          <HostStep
            value={check.hostText}
            onChangeText={check.onChangeHost}
            busy={busy}
            onSubmit={check.doCheck}
            onScan={() => setStage('scan')}
            // Nothing remembered and nothing found: the keyboard is the
            // next thing anyone needs, so it is already up.
            autoFocus={!check.hostText && !check.discovered}
            discovered={check.discovered}
            error={hostError}
            recent={check.recent}
            onPickRecent={check.onPickRecent}
            onForgetRecent={check.onForgetRecent}
          />
          <Rule bleed={theme.layout.margin} />
          <SetupSteps />
          <AwayFromHomeNote onSetUp={onOpenGuide} defaultOpen={check.recent.length === 0} />
          {adding && router.canGoBack() ? (
            <Button
              testID="cancel-add"
              label={'\u2039 Back to My Computers'}
              variant="ghost"
              fullWidth
              onPress={() => router.back()}
            />
          ) : null}
        </>
      ) : null}

      {stage === 'scan' ? (
        <ScanStep onScanned={(link) => void session.onScanned(link)} onCancel={() => setStage('host')} />
      ) : null}

      {stage === 'code' && host ? (
        <>
          {/* When the host will never issue a code, the dead-end notice owns
              the top of the screen and the accent: it states what was seen
              and routes forward (Tailscale, or the reset on the computer).
              The code entry survives below it, demoted, because the phone's
              knowledge goes stale the moment someone resets pairing on the
              computer — but nothing pretends a code exists right now. */}
          {check.deadEnd ? (
            <NoCodeStep
              hostName={host.name}
              platform={check.deadEnd.platform}
              standing={check.deadEnd.standing}
              detail={check.deadEnd.detail}
              checkedAt={check.deadEnd.checkedAt}
              onRecheck={check.onRetryTailscale}
              busy={busy}
            />
          ) : null}
          {/* The one-tap fix goes above the digits: turning Tailscale on is
              easier than reading a code off another screen, and it is what
              makes the computer reachable away from home too. While it is
              shown it holds the screen's accent; Pair demotes to fallback. */}
          {!check.deadEnd && check.tailscaleOff ? (
            <TailscaleStep
              hostName={check.tailscaleOff}
              detail={check.tailscaleDetail}
              onRetry={check.onRetryTailscale}
              onOpenTailscale={check.armTailscaleReturn}
              busy={busy}
            />
          ) : null}
          <PairStep
            host={host}
            code={code}
            onChangeCode={session.onChangeCode}
            onPair={session.doPair}
            onBack={check.onBack}
            busy={busy}
            error={pairError}
            primary={!check.tailscaleOff && !check.deadEnd}
            codeUnlikely={Boolean(check.deadEnd)}
          />
        </>
      ) : null}

      {stage === 'success' && host ? <SuccessNotice name={host.name} /> : null}
    </ScrollView>
  );
}
