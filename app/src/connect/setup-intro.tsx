// Setup intro screens — the beluga hero welcome + how it works, shown before
// the connect flow on a fresh install.
//
// The welcome is the app's first frame, so it earns the one hero moment the
// motion doctrine allows: the beluga mascot swims in its idle loop inside a
// soft blue halo (tap it and it does a flip), "Welcome to Belay" sits below in
// a calm sentence-case voice — deliberately not the 900-weight uppercase
// display, premium here means quiet — and a single accent button leads on.
// The page ground is the `heroBg` token, the ocean-tinted sibling of `bg`, so
// the white-beluga-in-blue-water video and the blue-rope brand share one
// palette instead of the mascot floating on a neutral page.
//
// Entrance: mascot → headline → CTA, each a 400ms fade with an 8pt rise
// (choreography in welcome-hero.ts, testable under node). Reduced motion
// renders everything in place with no animation.

import React, { useEffect } from 'react';
import { View, Pressable } from 'react-native';
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
import { HERO_ENTRANCE, haloLayers } from './welcome-hero';

interface WelcomeScreenProps {
  onContinue: () => void;
}

/** Mascot width, pt. Generous — this screen is the beluga's stage. */
const MASCOT_SIZE = 200;

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

// BelugaAvatar is only pressable when given a handler; the flip itself is the
// whole payoff here, so the handler has nothing left to do.
const NOOP = (): void => undefined;

/**
 * Welcome screen — the beluga hero. Mascot swimming in a blue halo (tap for a
 * flip), "Welcome to Belay", one line of what the app is, one way forward.
 */
export function WelcomeScreen({ onContinue }: WelcomeScreenProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  const mascotStyle = useHeroEntrance(HERO_ENTRANCE.mascotDelayMs, reduced);
  const headlineStyle = useHeroEntrance(HERO_ENTRANCE.headlineDelayMs, reduced);
  const ctaStyle = useHeroEntrance(HERO_ENTRANCE.ctaDelayMs, reduced);

  const halo = haloLayers(MASCOT_SIZE);
  const stageSize = halo[0]?.diameter ?? MASCOT_SIZE;

  // Sentence-case hero type: the display slot without the shouting — weight
  // 700 instead of 900, no uppercase. Shared between the two headline spans so
  // "Belay" differs from the rest by colour alone.
  const headlineType: TextStyle = {
    fontFamily: theme.font.sans,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700',
    letterSpacing: -0.8,
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

        {/* The cutout floats straight on the glow — no ring, no porthole.
            The beluga's own rope collar is the only outline it needs. */}
        <BelugaAvatar
          size={MASCOT_SIZE}
          onPress={NOOP}
          accessibilityLabel="Belay's beluga mascot"
          testID="welcome-beluga"
        />
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
          style={{ textAlign: 'center', maxWidth: 300, fontSize: 16, lineHeight: 24 }}
        >
          Control your computer from your phone. No cloud, no middleman.
        </Txt>
        <Txt variant="caption" tone="faint" style={{ textAlign: 'center', fontSize: 12 }}>
          Tap the beluga.
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
      // of the setup, not fine print — the guided walk-through comes next.
      label: '02',
      title: 'Set up Tailscale',
      detail: 'A free app that lets your phone reach your computer from anywhere. Belay walks you through it next.',
    },
    {
      label: '03',
      title: 'Pair your phone once',
      detail: 'Scan the QR code on your computer. After that, your phone remembers it.',
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
        <Txt
          variant="title"
          style={{
            fontSize: 32,
            lineHeight: 36,
            textTransform: 'none',
            color: theme.colors.text,
          }}
        >
          how it works
        </Txt>
        <Txt variant="caption" tone="dim" style={{ fontSize: 15, lineHeight: 22 }}>
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
              style={{
                width: 40,
                marginTop: 2,
              }}
            >
              {step.label}
            </Txt>

            {/* Content */}
            <View style={{ flex: 1, gap: theme.space.xxs }}>
              <Txt
                variant="bodyStrong"
                style={{
                  fontSize: 16,
                  lineHeight: 22,
                }}
              >
                {step.title}
              </Txt>
              <Txt
                variant="caption"
                tone="dim"
                style={{
                  fontSize: 14,
                  lineHeight: 20,
                }}
              >
                {step.detail}
              </Txt>
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
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={8}
            style={({ pressed }) => ({
              paddingVertical: theme.space.sm,
              minHeight: 44,
              justifyContent: 'center',
              opacity: pressed ? theme.motion.pressOpacity : 1,
            })}
          >
            <Txt
              variant="body"
              tone="dim"
              style={{
                textAlign: 'center',
                fontSize: 15,
              }}
            >
              ← Back
            </Txt>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
