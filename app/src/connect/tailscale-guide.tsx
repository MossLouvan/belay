// The guided Tailscale climb — connect from anywhere without typing anything.
//
// Four steps up: why, install, sign in, connect. The rope at the top is taken
// in as the user climbs (see rope-pull.tsx), and every step transition is a
// fade-and-rise in the app's one easing vocabulary. The last step does the
// thing the whole guide promises: it watches for the tailnet on a timer and
// on returning from the Tailscale app, and the moment the host answers over
// its tailnet address the continue button lights up — with the discovered
// address inside it, so nobody ever reads a port or a 100.x off a screen.
//
// Two ways in, one component. From a failed tailnet probe the guide knows
// which computer is waiting (`host` set) and can watch for it. From the cold
// "connect from anywhere" path there is no computer yet, so the last step
// ends at the QR scanner instead — the QR carries every address, tailnet
// included, and the race picks the one that works.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { checkHost } from '../api';
import type { HostCheck } from '../api';
import { useTheme } from '../theme';
import { Button, Label, Micro, Txt, haptic, useReducedMotion } from '../ui';
import { RopePull } from './rope-pull';
import { openTailscale } from './tailscale-card';
import type { GuideDetection, GuideStep } from './tailscale-flow';
import {
  GUIDE_CHECK_TIMEOUT_MS,
  GUIDE_POLL_MS,
  GUIDE_STEPS,
  guideProbeTarget,
  guideProgress,
  guideStepIndex,
  nextGuideStep,
  prevGuideStep,
  readGuideDetection,
} from './tailscale-flow';

/** The one bezier the app moves on, in reanimated's dialect. */
const EASE_STANDARD = Easing.bezier(0.2, 0, 0, 1);

/** The computer the guide is watching for, when it knows one. */
export interface GuideHost {
  /** The address that already answered — the poll starts from here. */
  readonly url: string;
  /** What to call it in the copy. */
  readonly name: string;
}

export interface TailscaleGuideProps {
  /** Set when a specific computer is waiting; null on the cold-start path. */
  readonly host: GuideHost | null;
  /** The last tailnet failure, shown small so a stuck setup is diagnosable. */
  readonly detail?: string | null;
  /** True while the caller is pairing over the discovered address. */
  readonly busy?: boolean;
  /** The tailnet answered — pair over this address, no code, no typing. */
  readonly onConnected: (url: string) => void;
  /** Fall back to the six digits. Only offered when a host is known. */
  readonly onUseCode?: () => void;
  /** Cold path's ending: scan the QR, which carries the tailnet address. */
  readonly onScan: () => void;
  /** Leave the guide entirely. */
  readonly onClose: () => void;
}

interface StepCopy {
  readonly ordinal: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The words for each step. Warm, plain, sentence case — the reader has never
 * heard of a tailnet and never needs to.
 */
function copyFor(step: GuideStep, hostName: string | null): StepCopy {
  switch (step) {
    case 'intro':
      return {
        ordinal: '',
        title: 'Reach your computer from anywhere',
        body:
          'Right now Belay only works at home. Tailscale puts your phone and ' +
          'computer on the same private network wherever you are — free for ' +
          'personal use, and about two minutes to set up.',
      };
    case 'install':
      return {
        ordinal: '01',
        title: 'Install Tailscale',
        body:
          'Get the free Tailscale app from the App Store. It runs quietly in ' +
          'the background — you will almost never open it again.',
      };
    case 'account':
      return {
        ordinal: '02',
        title: 'Sign in on both devices',
        body:
          'Open Tailscale and sign in — an Apple or Google account works. Use ' +
          'the same account on your computer, so the two can find each other.',
      };
    case 'connect':
      return {
        ordinal: '03',
        title: 'Connect this phone',
        body: hostName
          ? `Flip the switch in Tailscale so this phone joins your network. ` +
            `Belay is watching, and will notice the moment ${hostName} can hear you.`
          : 'Flip the switch in Tailscale so this phone joins your network. ' +
            'Then scan the code on your computer — it will connect from anywhere.',
      };
  }
}

/** How long each poll may wait before it counts as "not yet". */
async function checkBounded(url: string): Promise<HostCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bail = new Promise<HostCheck>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'timed out' }), GUIDE_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([checkHost(url), bail]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One row of climb dots — where you are on the rope, at a glance. */
function StepDots({ step }: { step: GuideStep }) {
  const theme = useTheme();
  const active = guideStepIndex(step);
  return (
    <View
      style={{ flexDirection: 'row', gap: theme.space.sm, justifyContent: 'center' }}
      accessibilityLabel={`Step ${active + 1} of ${GUIDE_STEPS.length}`}
    >
      {GUIDE_STEPS.map((s, i) => (
        <View
          key={s}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i <= active ? theme.colors.accentGraphic : theme.colors.trackRest,
          }}
        />
      ))}
    </View>
  );
}

export function TailscaleGuide({
  host,
  detail,
  busy,
  onConnected,
  onUseCode,
  onScan,
  onClose,
}: TailscaleGuideProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();

  const [step, setStep] = useState<GuideStep>('intro');
  const [detection, setDetection] = useState<GuideDetection>({ kind: 'waiting' });

  /** False once unmounted, so a late poll cannot set state. */
  const live = useRef(true);
  /** True while a poll is in flight — a slow one just skips the next tick. */
  const polling = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Step content fades and rises on each transition; reduced motion cuts.
  const stepAnim = useSharedValue(1);
  const stepStyle = useAnimatedStyle(() => ({
    opacity: stepAnim.value,
    transform: [{ translateY: (1 - stepAnim.value) * 14 }],
  }));

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const goTo = useCallback(
    (next: GuideStep) => {
      haptic('light');
      if (reducedMotion) {
        setStep(next);
        return;
      }
      stepAnim.value = withTiming(0, { duration: theme.motion.fast, easing: EASE_STANDARD });
      // Swap content at the bottom of the fade, then rise back in.
      setTimeout(() => {
        if (!live.current) return;
        setStep(next);
        stepAnim.value = withTiming(1, { duration: theme.motion.base, easing: EASE_STANDARD });
      }, theme.motion.fast);
    },
    [reducedMotion, stepAnim, theme.motion],
  );

  const advance = useCallback(() => {
    const next = nextGuideStep(step);
    if (next) goTo(next);
  }, [step, goTo]);

  const retreat = useCallback(() => {
    const prev = prevGuideStep(step);
    if (prev) goTo(prev);
    else onClose();
  }, [step, goTo, onClose]);

  /**
   * One round of watching: re-check the address that worked before, follow
   * its advertised tailnet address if there is one, and read the result. All
   * failure modes land as state — an unreachable host is "still waiting",
   * never an error screen, because the user is off in another app fixing it.
   */
  const poll = useCallback(async () => {
    if (!host || polling.current) return;
    polling.current = true;
    try {
      const check = await checkBounded(host.url);
      if (!live.current) return;
      const target = guideProbeTarget(check, host.url);
      const probe = target ? await checkBounded(target) : null;
      if (!live.current) return;
      setDetection((current) => {
        // Never demote a found connection — a later, slower poll losing a
        // race must not un-light the button under the user's finger.
        if (current.kind === 'connected') return current;
        const next = readGuideDetection(check, host.url, probe);
        if (next.kind === 'connected') haptic('success');
        return next;
      });
    } finally {
      polling.current = false;
    }
  }, [host]);

  // Watch while on the connect step: a steady timer, plus an immediate check
  // whenever the app returns to the foreground (the user just flipped the
  // switch in Tailscale and came straight back).
  const watching = step === 'connect' && host !== null && detection.kind !== 'connected';
  useEffect(() => {
    if (!watching) return;
    void poll();
    const timer = setInterval(() => void poll(), GUIDE_POLL_MS);
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'active' && prev.match(/inactive|background/)) void poll();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [watching, poll]);

  const copy = copyFor(step, host?.name ?? null);
  const connected = detection.kind === 'connected';

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: theme.layout.margin * 1.5,
        paddingTop: insets.top,
        paddingBottom: insets.bottom + theme.space.xl,
        flexGrow: 1,
        width: '100%',
        maxWidth: theme.layout.contentMaxWidth,
        alignSelf: 'center',
      }}
      showsVerticalScrollIndicator={false}
      testID="tailscale-guide"
    >
      {/* The rope is taken in as the climb progresses; everything below it
          rides up — that is the pull. */}
      <RopePull progress={guideProgress(step)} />

      <Animated.View style={[{ gap: theme.space.xl, paddingTop: theme.space.lg }, stepStyle]}>
        {/* Headline block */}
        <View style={{ gap: theme.space.sm }}>
          {copy.ordinal ? <Label style={{ marginBottom: 0 }}>{copy.ordinal}</Label> : null}
          <Txt
            variant="title"
            adjustsFontSizeToFit
            numberOfLines={2}
            style={{ fontSize: 32, lineHeight: 36, textTransform: 'none' }}
          >
            {copy.title}
          </Txt>
          <Txt variant="body" tone="dim" style={{ fontSize: 15, lineHeight: 22 }}>
            {copy.body}
          </Txt>
        </View>

        {/* Step-specific actions */}
        {step === 'intro' ? (
          <View style={{ gap: theme.space.sm }}>
            <Button label="Set it up" onPress={advance} fullWidth size="lg" testID="guide-intro-continue" />
            {onUseCode ? (
              <Button label="Use the pairing code instead" variant="ghost" onPress={onUseCode} fullWidth />
            ) : null}
          </View>
        ) : null}

        {step === 'install' ? (
          <View style={{ gap: theme.space.sm }}>
            <Button label="Get Tailscale" onPress={() => void openTailscale()} fullWidth size="lg" />
            <Button label="I have it — next" variant="secondary" onPress={advance} fullWidth size="lg" testID="guide-install-next" />
          </View>
        ) : null}

        {step === 'account' ? (
          <View style={{ gap: theme.space.sm }}>
            <Button label="Open Tailscale" onPress={() => void openTailscale()} fullWidth size="lg" />
            <Button label="I'm signed in — next" variant="secondary" onPress={advance} fullWidth size="lg" testID="guide-account-next" />
          </View>
        ) : null}

        {step === 'connect' && host ? (
          <View style={{ gap: theme.space.md }}>
            {/* What the watcher sees right now, in one honest line. */}
            {connected ? (
              <Txt variant="label" tone="good" testID="guide-connected">
                {`✓ ${host.name} can hear you`}
              </Txt>
            ) : detection.kind === 'code-required' ? (
              <Txt variant="label" tone="warn">
                {`Connected — but ${host.name} still asks for its code`}
              </Txt>
            ) : detection.kind === 'no-tailnet' ? (
              <Txt variant="label" tone="warn">Your computer is not on Tailscale yet</Txt>
            ) : (
              <Txt variant="label" tone="dim">{`Watching for ${host.name}…`}</Txt>
            )}

            {detection.kind === 'no-tailnet' ? (
              <Txt variant="caption" tone="dim">
                Install Tailscale on the computer too, sign in with the same account, and Belay
                will pick it up from here.
              </Txt>
            ) : null}

            <View style={{ gap: theme.space.sm }}>
              {!connected ? (
                <Button label="Open Tailscale" onPress={() => void openTailscale()} fullWidth size="lg" />
              ) : null}
              {/* The promise: lights up on its own, and carries the discovered
                  address — nothing to type, ever. */}
              <Button
                label={connected ? "You're connected — continue" : 'Waiting for Tailscale…'}
                onPress={() => {
                  if (detection.kind === 'connected') onConnected(detection.url);
                }}
                disabled={!connected}
                loading={busy}
                variant={connected ? 'primary' : 'secondary'}
                fullWidth
                size="lg"
                testID="guide-continue"
              />
              {detection.kind === 'code-required' && onUseCode ? (
                <Button label="Enter the pairing code" variant="secondary" onPress={onUseCode} fullWidth size="lg" />
              ) : null}
            </View>

            {!connected && detection.kind === 'waiting' && (detection.detail ?? detail) ? (
              <Micro tone="faint">{`Last check said: ${detection.detail ?? detail}`}</Micro>
            ) : null}
          </View>
        ) : null}

        {step === 'connect' && !host ? (
          <View style={{ gap: theme.space.sm }}>
            <Button label="Open Tailscale" onPress={() => void openTailscale()} fullWidth size="lg" />
            <Button label="Scan the code on your computer" variant="secondary" onPress={onScan} fullWidth size="lg" testID="guide-scan" />
          </View>
        ) : null}
      </Animated.View>

      {/* Footer: where you are on the rope, and the way back down. */}
      <View style={{ marginTop: 'auto', gap: theme.space.md, paddingTop: theme.space.xl }}>
        <StepDots step={step} />
        <Pressable
          onPress={retreat}
          accessibilityRole="button"
          accessibilityLabel={step === 'intro' ? 'Close Tailscale setup' : 'Go back a step'}
          style={({ pressed }) => ({
            paddingVertical: theme.space.sm,
            opacity: pressed ? theme.motion.pressOpacity : 1,
          })}
        >
          <Txt variant="body" tone="dim" style={{ textAlign: 'center', fontSize: 15 }}>
            {step === 'intro' ? 'Not now' : '← Back'}
          </Txt>
        </Pressable>
      </View>
    </ScrollView>
  );
}
