// Setup intro — the beluga hero "put Belay on your computer" screen, shown
// once a fresh install is signed in and has no computer yet. The why lives on
// the sign-in screen just before it; this screen is the one thing to do next:
// open Belay on the computer and scan its QR. Connecting by address is the
// quiet advanced door underneath.
//
// The welcome is the app's first frame, so it earns the one hero moment the
// motion doctrine allows: the cartoon beluga settles in inside a
// soft halo, "Put Belay on your computer" sits below in
// a calm sentence-case voice — deliberately not the 900-weight uppercase
// display, premium here means quiet — and a single accent button leads on.
// The page ground is the `heroBg` token, the ocean-tinted sibling of `bg`, so
// the cream beluga and the rope brand share one
// palette instead of the mascot floating on a neutral page.
//
// Entrance: mascot → headline → CTA, each a 400ms fade with an 8pt rise
// (choreography in welcome-hero.ts, testable under node). Reduced motion
// renders everything in place with no animation.

import React, { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import type { TextStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { BelugaIllustration, Button, Swash, Txt, useReducedMotion } from '../ui';
import { HERO_ENTRANCE, haloLayers } from './welcome-hero';

interface WelcomeScreenProps {
  /** Scan (or type) the claim code Belay shows on the computer. */
  onLink: () => void;
  /** The advanced door: connect by address and pairing code. */
  onAdvanced: () => void;
}

/** The cartoon beluga's width, pt. Generous — this screen is the beluga's stage. */
const MASCOT_SIZE = 150;

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
 * The beluga hero. Mascot swimming in a blue halo (tap for a flip), "Put Belay
 * on your computer", one line of how, one way forward and one advanced door.
 */
export function WelcomeScreen({ onLink, onAdvanced }: WelcomeScreenProps) {
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
  const ownDisplayFace = theme.font.display !== theme.font.sans;
  const headlineType: TextStyle = {
    // The display face: Fredoka under Harbour (one weight per family, so
    // 'normal'), the UI face at 700 elsewhere.
    fontFamily: theme.font.display,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: ownDisplayFace ? 'normal' : '700',
    letterSpacing: ownDisplayFace ? -0.3 : -0.8,
    textAlign: 'center',
  };

  return (
    // Scrolls: in landscape the hero is taller than the screen, and the one
    // button forward must never sit below an unscrollable fold.
    <ScrollView
      testID="welcome-screen"
      style={{ flex: 1, backgroundColor: theme.colors.heroBg }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: theme.layout.margin * 1.5,
        paddingVertical: theme.space.xl,
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

        {/* The cartoon floats straight on the glow — no ring, no porthole. */}
        <View testID="welcome-beluga">
          <BelugaIllustration size={MASCOT_SIZE} accessibilityLabel="Belay's beluga mascot" />
        </View>
      </Animated.View>

      {/* Headline + one line of what this is. */}
      <Animated.View style={[{ alignItems: 'center', gap: theme.space.sm }, headlineStyle]}>
        <Txt variant="display" heading style={{ ...headlineType, textTransform: 'none', color: theme.colors.text }}>
          Put{' '}
          <Txt variant="display" style={{ ...headlineType, textTransform: 'none', color: theme.colors.accent }}>
            Belay
          </Txt>
          {' '}on your <Swash>computer</Swash>
        </Txt>
        <Txt
          variant="body"
          tone="dim"
          style={{ textAlign: 'center', maxWidth: 320, fontSize: 16, lineHeight: 24 }}
        >
          Get Belay for Mac or Windows at gobelay.com and open it. It shows a QR code: scan it here to link the computer.
        </Txt>
      </Animated.View>

      {/* The way forward — the screen's single solid accent. */}
      <Animated.View style={[{ width: '100%', maxWidth: 300, marginTop: theme.space.md }, ctaStyle]}>
        <Button
          label="Scan the QR code"
          onPress={onLink}
          fullWidth
          size="lg"
          testID="welcome-continue"
        />
        <Button
          label="Advanced: connect by address"
          onPress={onAdvanced}
          variant="ghost"
          fullWidth
          testID="welcome-advanced"
          style={{ marginTop: theme.space.sm }}
        />
      </Animated.View>
    </ScrollView>
  );
}
