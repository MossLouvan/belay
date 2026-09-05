// Blue rope + carabiner brand splash — the startup composition.
//
// Black canvas, blue rope under tension, carabiner being pulled/clipped,
// BELAY wordmark + tagline bottom-right. Animated sequence: rope drops with
// weight → carabiner clips on under load (pull/tension physics) → wordmark
// fades up. The motion shows a real climbing carabiner being clipped and
// loaded, not an ornament hanging idle.

import React, { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { Txt, Micro, useReducedMotion } from '../ui';
import { Carabiner } from '../ui/carabiner';
import { CurvedRopeStrand } from '../ui/rope-strand';
import { SPRING_CONFIGS } from '../ui/motion';

interface RopeSplashProps {
  /** Whether to play the animation. Set false for reduced motion instant display. */
  animated?: boolean;
}

/** Stroke weight of the splash rope, in points. */
const ROPE_STROKE = 6;

/**
 * Curved rope with helical braid pattern under tension.
 * Uses shared CurvedRopeStrand for consistent rendering across the app.
 */
function Rope({ width, height, color }: { width: number; height: number; color: string }) {
  return (
    <View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]} pointerEvents="none">
      <CurvedRopeStrand width={width} height={height} color={color} ropeStroke={ROPE_STROKE} />
    </View>
  );
}

/**
 * Full rope + carabiner + wordmark splash composition.
 * Animation sequence:
 * 1. Rope drops down with weight (shows tension)
 * 2. Carabiner clips onto rope with pull/load physics (not hanging idle)
 * 3. Brief settle as the system comes under tension
 * 4. Wordmark fades in upwards from below
 */
export function RopeSplash({ animated = true }: RopeSplashProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const shouldAnimate = animated && !reducedMotion;

  // Animation values
  const ropeY = useSharedValue(shouldAnimate ? -100 : 0);
  const carabinerY = useSharedValue(shouldAnimate ? -80 : 0);
  const carabinerOpacity = useSharedValue(shouldAnimate ? 0 : 1);
  const carabinerRotate = useSharedValue(shouldAnimate ? 15 : 0);
  const carabinerScale = useSharedValue(shouldAnimate ? 0.8 : 1);
  const wordmarkY = useSharedValue(shouldAnimate ? 30 : 0);
  const wordmarkOpacity = useSharedValue(shouldAnimate ? 0 : 1);

  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!shouldAnimate) return;
    // Allow re-animation on remount by checking if values are at their starting positions
    if (hasAnimated.current && ropeY.value === 0) return;
    hasAnimated.current = true;

    // 1. Rope drops with weight (fast drop showing gravity)
    ropeY.value = withSpring(0, {
      damping: 18,
      stiffness: 400,
      mass: 0.5,
      overshootClamping: false,
    });

    // 2. Carabiner clips on with pull physics (rotation + scale + position)
    // Shows the carabiner being clipped onto the rope under load
    carabinerOpacity.value = withDelay(100, withTiming(1, { duration: 150 }));
    
    // Clip motion: starts rotated, snaps to vertical as it clips on
    carabinerRotate.value = withDelay(
      100,
      withSequence(
        withTiming(8, { duration: 100 }), // Brief swing as it approaches
        withSpring(0, { damping: 12, stiffness: 400, mass: 0.5 }) // Snap to load-bearing position
      )
    );
    
    // Scale shows the impact/clip moment
    carabinerScale.value = withDelay(
      100,
      withSequence(
        withTiming(1.05, { duration: 100 }), // Brief expansion as it clips
        withSpring(1, SPRING_CONFIGS.snappy) // Settle under load
      )
    );
    
    // Drop down and settle (pulled by weight, not just sliding)
    carabinerY.value = withDelay(
      100,
      withSequence(
        withSpring(5, { damping: 8, stiffness: 250, mass: 0.7 }), // Drop with bounce (under load)
        withSpring(0, { damping: 15, stiffness: 300, mass: 0.8 }) // Settle to rest under tension
      )
    );

    // 3. Wordmark fades in while the clip is settling (overlapping, not sequential)
    wordmarkOpacity.value = withDelay(
      350,
      withTiming(1, { duration: theme.motion.base })
    );
    wordmarkY.value = withDelay(
      350,
      withSpring(0, SPRING_CONFIGS.gentle)
    );
  }, [shouldAnimate, ropeY, carabinerY, carabinerOpacity, carabinerRotate, carabinerScale, wordmarkY, wordmarkOpacity, theme.motion.base]);

  const ropeStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ropeY.value }],
  }));

  const carabinerStyle = useAnimatedStyle(() => ({
    opacity: carabinerOpacity.value,
    transform: [
      { translateY: carabinerY.value },
      { rotate: `${carabinerRotate.value}deg` },
      { scale: carabinerScale.value },
    ],
  }));

  const wordmarkStyle = useAnimatedStyle(() => ({
    opacity: wordmarkOpacity.value,
    transform: [{ translateY: wordmarkY.value }],
  }));

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.bg,
      }}
      accessibilityLabel="Belay - hold the line"
    >
      {/* Rope across top third */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          ropeStyle,
        ]}
      >
        <Rope
          width={400} // Will scale with screen
          height={300}
          color={theme.colors.accentGraphic}
        />
      </Animated.View>

      {/* Carabiner at sag point */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            top: '20%', // Matches rope sag
            left: '50%',
            marginLeft: -20, // Half carabiner width for centering
          },
          carabinerStyle,
        ]}
      >
        <Carabiner size={40} color={theme.colors.accentGraphic} />
      </Animated.View>

      {/* BELAY wordmark + tagline bottom-right, with safe area inset */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            bottom: insets.bottom + theme.space.xxl + theme.space.lg,
            right: theme.layout.margin,
            alignItems: 'flex-end',
            gap: theme.space.xxs,
          },
          wordmarkStyle,
        ]}
      >
        <Txt
          variant="display"
          style={{
            fontSize: 48,
            lineHeight: 52,
            letterSpacing: -1.5,
            color: theme.colors.text,
          }}
        >
          BELAY
        </Txt>
        <Micro
          tone="dim"
          style={{
            letterSpacing: 2,
            fontSize: 10,
          }}
        >
          HOLD THE LINE
        </Micro>
      </Animated.View>
    </View>
  );
}
