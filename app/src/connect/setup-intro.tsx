// Setup intro screens — the beluga hero welcome + how it works, shown before
// the connect flow on a fresh install.
//
// The welcome is the app's first frame, so it earns the one hero moment the
// motion doctrine allows: the beluga mark fades up inside a soft blue halo,
// "Welcome to Belay" sits below in a calm sentence-case voice — deliberately
// not the 900-weight uppercase display, premium here means quiet — and a
// single accent button leads on. The mark is a picture and nothing more: it
// carried a press handler that did nothing, on a promise of a flip animation
// the app had already deleted.
// The page ground is the `heroBg` token, the ocean-tinted sibling of `bg`, so
// the white-beluga-in-blue-water video and the blue-rope brand share one
// palette instead of the mascot floating on a neutral page.
//
// Entrance: mascot → headline → CTA, each a 400ms fade with an 8pt rise
// (choreography in welcome-hero.ts, testable under node). Reduced motion
// renders everything in place with no animation.

import React, { useEffect } from 'react';
import { View } from 'react-native';
import type { TextStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { BelugaAvatar, Button, Txt, useReducedMotion } from '../ui';
import { MIN_MARK_SIZE } from '../ui/beluga-avatar';
import { HERO_ENTRANCE, haloLayers } from './welcome-hero';

interface WelcomeScreenProps {
  onContinue: () => void;
}

// Mark width, pt. This screen IS the beluga's stage, and the drawing needs
// real diameter before the melon reads as a melon (see ui/beluga-avatar.tsx).
// It used to ask for 40 here and the component silently capped it at 40 too,
// so the app's first frame showed the mark at the one size it does not work
// at. `MIN_MARK_SIZE` is the floor; the hero sits comfortably above it.
const MASCOT_SIZE = Math.max(176, MIN_MARK_SIZE);

// The welcome headline is a brand lockup, not body copy: it is deliberately
// one step above `display` because it is the only thing on the app's first
// frame. Named rather than left as bare literals so it is obvious this is the
// sanctioned exception to the type scale and not another hand-tune.
const HERO_HEADLINE_SIZE = 34;
const HERO_HEADLINE_LINE_HEIGHT = 40;

/** The one easing the app moves on (theme `easing.standard`), as a worklet. */
const EASE_STANDARD = Easing.bezier(0.2, 0, 0, 1);

/**
 * One block of the entrance choreography: fades in and rises 8pt into place
 * after `delayMs`, or renders settled immediately under reduced motion.
 */
function useHeroEntrance(delayMs: number, reduced: boolean) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      delayMs,
      withTiming(1, { duration: HERO_ENTRANCE.durationMs, easing: EASE_STANDARD }),
    );
  }, [progress, delayMs, reduced]);

  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * HERO_ENTRANCE.riseDistancePt }],
  }));
}

/**
 * Welcome screen — the beluga hero. The mark in a blue halo, "Welcome to
 * Belay", one line of what the app is, one way forward.
 */
export function WelcomeScreen({ onContinue }: WelcomeScreenProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  const mascotStyle = useHeroEntrance(HERO_ENTRANCE.mascotDelayMs, reduced);
  const headlineStyle = useHeroEntrance(HERO_ENTRANCE.headlineDelayMs, reduced);
  const ctaStyle = useHeroEntrance(HERO_ENTRANCE.ctaDelayMs, reduced);

  const halo = haloLayers(MASCOT_SIZE);
  const stageSize = halo[0]?.diameter ?? MASCOT_SIZE;

  // Sentence-case hero type: the `display` slot without the shouting — weight
  // 700 instead of 800, no uppercase, one step larger because this is the
  // app's first frame. Everything but those three deltas comes from the scale,
  // and both headline spans share it so "Belay" differs by colour alone.
  const headlineType: TextStyle = {
    ...theme.type.display,
    fontSize: HERO_HEADLINE_SIZE,
    lineHeight: HERO_HEADLINE_LINE_HEIGHT,
    fontWeight: '700',
    textAlign: 'center',
  };

  return (
    <View
      testID="welcome-screen"
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.heroBg,
        paddingHorizontal: theme.layout.margin * 1.5,
        gap: theme.space.xl,
      }}
    >
      {/* The beluga's stage: glow rings behind, ring stroke around, mascot on
          top. The rings are pure garnish — hidden from assistive tech. */}
      <Animated.View
        style={[
          {
            width: stageSize,
            height: stageSize,
            alignItems: 'center',
            justifyContent: 'center',
          },
          mascotStyle,
        ]}
      >
        {halo.map((layer) => (
          <View
            key={layer.diameter}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: layer.diameter,
              height: layer.diameter,
              borderRadius: layer.diameter / 2,
              backgroundColor: theme.colors.heroGlow,
              opacity: layer.opacity,
            }}
          />
        ))}

        {/* The mark floats straight on the glow — no ring, no porthole. It is
            decoration, so it stays out of the accessibility tree entirely and
            the headline below does the talking. */}
        <BelugaAvatar size={MASCOT_SIZE} testID="welcome-beluga" />
      </Animated.View>

      {/* Headline + one line of what this is. */}
      <Animated.View style={[{ alignItems: 'center', gap: theme.space.sm }, headlineStyle]}>
        <Txt variant="display" heading style={{ ...headlineType, textTransform: 'none', color: theme.colors.text }}>
          Welcome to{' '}
          <Txt variant="display" style={{ ...headlineType, textTransform: 'none', color: theme.colors.accent }}>
            Belay
          </Txt>
        </Txt>
        <Txt
          variant="body"
          tone="dim"
          style={{ textAlign: 'center', maxWidth: 300 }}
        >
          Control your computer from your phone. No cloud, no middleman.
        </Txt>
        <Txt variant="micro" tone="faint" style={{ textAlign: 'center' }}>
          Your devices. Your workspace.
        </Txt>
      </Animated.View>

      {/* The way forward — the screen's single solid accent. */}
      <Animated.View style={[{ width: '100%', maxWidth: 300, marginTop: theme.space.md }, ctaStyle]}>
        <Button
          label="Get started"
          onPress={onContinue}
          fullWidth
          size="lg"
          testID="welcome-continue"
        />
      </Animated.View>
    </View>
  );
}

interface HowItWorksScreenProps {
  onContinue: () => void;
  onBack?: () => void;
}

/**
 * How it works — single screen explaining the concept, typography-first,
 * minimal list. Not a dense card wall, just clean vertical prose.
 */
export function HowItWorksScreen({ onContinue, onBack }: HowItWorksScreenProps) {
  const theme = useTheme();

  const steps = [
    {
      label: '01',
      title: 'Start the host on your computer',
      detail: 'A small program that lets Belay connect. Leave it running.',
    },
    {
      // Away-from-home is the main use case, so Tailscale is a headline step
      // of the setup, not fine print — and its address is the way in.
      label: '02',
      title: 'Set up Tailscale',
      detail: 'A free app that lets your phone reach your computer from anywhere. Belay can walk you through it.',
    },
    {
      label: '03',
      title: 'Type the address once',
      detail: 'Copy your computer\'s address from the Tailscale app — it starts with 100. After that, your phone remembers it.',
    },
    {
      label: '04',
      title: 'Control your computer',
      detail: 'Screen, terminal, files, system — all from your phone.',
    },
  ];

  return (
    <View
      testID="how-it-works-screen"
      style={{
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: theme.layout.margin * 1.5,
        gap: theme.space.xxl,
      }}
    >
      {/* Section headline */}
      <View style={{ gap: theme.space.sm }}>
        <Txt variant="display" heading style={{ textTransform: 'none' }}>
          how it works
        </Txt>
        <Txt variant="body" tone="dim">
          Direct connection between your devices. Nothing routes through anyone else.
        </Txt>
      </View>

      {/* Clean vertical step list */}
      <View style={{ gap: theme.space.lg }}>
        {steps.map((step) => (
          <View
            key={step.label}
            style={{
              flexDirection: 'row',
              gap: theme.space.md,
              alignItems: 'flex-start',
            }}
          >
            {/* Mono ordinal in margin */}
            <Txt
              variant="label"
              tone="accent"
              style={{ width: theme.space.xl, marginTop: 2 }}
            >
              {step.label}
            </Txt>

            {/* Content */}
            <View style={{ flex: 1, gap: theme.space.xxs }}>
              <Txt variant="bodyStrong">{step.title}</Txt>
              <Txt variant="caption" tone="dim">{step.detail}</Txt>
            </View>
          </View>
        ))}
      </View>

      {/* CTAs */}
      <View style={{ gap: theme.space.sm, marginTop: theme.space.lg }}>
        <Button
          label="Continue"
          onPress={onContinue}
          fullWidth
          size="lg"
          testID="how-it-works-continue"
        />
        {onBack ? (
          <Button
            label="← Back"
            variant="ghost"
            onPress={onBack}
            fullWidth
            accessibilityLabel="Go back"
            testID="how-it-works-back"
          />
        ) : null}
      </View>
    </View>
  );
}
