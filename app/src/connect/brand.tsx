// Wordmark and logo for the connect screen. Drawn from Views so there is no
// image to decode and it recolours with the theme.
//
// The brand animation: a climbing rope slings down in an arc, then a carabiner
// drops and clips into place. Blue accent throughout (Belay ledger blue).
// Motion respects reduced-motion preferences.

import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { useTheme } from '../theme';
import { Carabiner, Txt, useReducedMotion } from '../ui';

const ROPE_BLUE = '#0066CC'; // Belay blue accent
const ANIMATION_DELAY = 200;
const ROPE_DURATION = 800;
const CARABINER_DURATION = 400;

/** The link mark: a filled square joined to an outlined one. */
export function LogoMark({ size = 20 }: { size?: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      <View style={{ width: size, height: size, backgroundColor: ROPE_BLUE }} />
      <View style={{ width: size, height: theme.layout.ruleEmphasis, backgroundColor: ROPE_BLUE }} />
      <View
        style={{
          width: size,
          height: size,
          borderWidth: theme.layout.ruleEmphasis,
          borderColor: ROPE_BLUE,
        }}
      />
    </View>
  );
}

/** Animated rope that slings down with a natural arc. */
function RopeAnimation({ reducedMotion }: { reducedMotion: boolean }) {
  const ropeProgress = useRef(new Animated.Value(0)).current;
  const theme = useTheme();

  useEffect(() => {
    if (reducedMotion) {
      ropeProgress.setValue(1);
      return;
    }

    const animation = Animated.timing(ropeProgress, {
      toValue: 1,
      duration: ROPE_DURATION,
      delay: ANIMATION_DELAY,
      useNativeDriver: true,
    });

    animation.start();
    return () => animation.stop();
  }, [ropeProgress, reducedMotion]);

  // Rope arc: starts at top center, slings down with a bezier-like curve
  const ropeHeight = 120;
  const ropeWidth = 140;

  // Create SVG-like path using positioned views to simulate rope curve
  const segments = 20;
  const ropeSegments = Array.from({ length: segments }, (_, i) => {
    const t = i / (segments - 1);
    // Catenary curve approximation for natural rope sag
    const x = (t - 0.5) * ropeWidth;
    const y = t * ropeHeight + Math.pow(t * 2 - 1, 2) * 30;
    
    return { x, y, opacity: ropeProgress.interpolate({
      inputRange: [0, t, 1],
      outputRange: [0, 1, 1],
      extrapolate: 'clamp',
    })};
  });

  return (
    <View
      style={{
        width: ropeWidth,
        height: ropeHeight,
        alignItems: 'center',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {ropeSegments.map((segment, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            left: ropeWidth / 2 + segment.x,
            top: segment.y,
            width: 4,
            height: 8,
            backgroundColor: ROPE_BLUE,
            borderRadius: 2,
            opacity: segment.opacity,
          }}
        />
      ))}
    </View>
  );
}

/** Carabiner that drops down and clips into position. */
function CarabinerAnimation({ reducedMotion }: { reducedMotion: boolean }) {
  const carabinerY = useRef(new Animated.Value(-50)).current;
  const carabinerOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reducedMotion) {
      carabinerY.setValue(0);
      carabinerOpacity.setValue(1);
      return;
    }

    const animation = Animated.sequence([
      Animated.delay(ANIMATION_DELAY + ROPE_DURATION),
      Animated.parallel([
        Animated.timing(carabinerY, {
          toValue: 0,
          duration: CARABINER_DURATION,
          useNativeDriver: true,
        }),
        Animated.timing(carabinerOpacity, {
          toValue: 1,
          duration: CARABINER_DURATION / 2,
          useNativeDriver: true,
        }),
      ]),
    ]);

    animation.start();
    return () => animation.stop();
  }, [carabinerY, carabinerOpacity, reducedMotion]);

  return (
    <Animated.View
      style={{
        transform: [{ translateY: carabinerY }],
        opacity: carabinerOpacity,
      }}
    >
      <Carabiner size={40} color={ROPE_BLUE} strokeWidth={3} />
    </Animated.View>
  );
}

/** Animated brand: rope slings down, carabiner clips into place. */
export function Brand() {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();

  return (
    <View style={{ alignItems: 'center', paddingBottom: theme.space.lg }}>
      <View style={{ alignItems: 'center', marginBottom: theme.space.md }}>
        <RopeAnimation reducedMotion={reducedMotion} />
        <CarabinerAnimation reducedMotion={reducedMotion} />
      </View>
      <Txt
        variant="display"
        style={{
          fontSize: 36,
          lineHeight: 40,
          textTransform: 'none',
          letterSpacing: -1,
          color: ROPE_BLUE,
        }}
      >
        Belay
      </Txt>
    </View>
  );
}
