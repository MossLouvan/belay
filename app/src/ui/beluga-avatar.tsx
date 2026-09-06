// The Belay beluga mascot — cohesive identity across stream HUD and tools drawer.
//
// This is the CUTOUT era: `beluga-cutout.png` is a transparent RGBA cutout
// (642x537, rope collar + carabiner intact), so the mascot floats directly on
// whatever surface hosts it. No circle, no water, no video — the old
// expo-video swim/flip clips are retired (the files stay on disk, unused).
//
// IDLE (default, always, unless reduced motion):
//   - A slow vertical bob + a subtle rotational sway, phase-offset so the
//     two never sync up — reads as treading water, not a metronome.
//
// ON PRESS (click/tap):
//   - One-shot 360° flip with a small jump arc and an apex swell, driven by
//     a single 0..1 progress value; on completion the beluga settles back
//     into the idle swim. Double-taps mid-flip are ignored (the flip guard),
//     but `onPress` still fires on the first tap — callers rely on it.
//   - Reduced motion: no travel at all; `onPress` and the haptic still fire.
//
// Choreography numbers + arc math live in ./beluga-motion.ts (pure, tested).

import React, { useCallback, useEffect } from 'react';
import { Image, Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { haptic } from './haptics';
import { useReducedMotion } from './motion';
import {
  belugaImageBox,
  flipJumpOffset,
  flipRotation,
  flipScale,
  FLIP_DURATION_MS,
  IDLE_BOB_HALF_CYCLE_MS,
  IDLE_BOB_TRAVEL_FRACTION,
  IDLE_SWAY_HALF_CYCLE_MS,
  IDLE_SWAY_DEGREES,
} from './beluga-motion';

const BELUGA_CUTOUT = require('../../assets/beluga-cutout.png');

export interface BelugaAvatarProps {
  /** Avatar size in pixels (width of the cutout's bounding box). */
  size: number;
  /** Optional press handler. If omitted, the avatar is still animated but not pressable. */
  onPress?: () => void;
  /**
   * Legacy prop from the circular-crop era; the cutout is transparent, so
   * nothing is painted behind it any more. Kept for API compatibility.
   */
  backgroundColor?: string;
  /** Accessibility label. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The Belay beluga mascot: a transparent cutout that gently swims in place.
 * Used in the stream HUD (48px, top-right) and tools drawer header (40px).
 *
 * IDLE: slow bob + subtle sway, looping (suppressed under reduced motion).
 * PRESS: one-shot 360° flip with a jump arc, then back to the idle swim.
 */
export function BelugaAvatar({
  size,
  onPress,
  backgroundColor: _backgroundColor, // unused since the cutout era — see props doc
  accessibilityLabel = 'Belay mascot',
  style,
  testID,
}: BelugaAvatarProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();

  // Idle swim drivers: two independent loops, deliberately off-beat.
  const bob = useSharedValue(0);
  const sway = useSharedValue(0);
  // Flip driver: 0..1 progress of the one-shot. Doubles as the tap guard —
  // a flip is in flight whenever `flipping` is true.
  const flipProgress = useSharedValue(0);
  const flipping = useSharedValue(false);

  // Start (or stop) the idle swim. Reduced motion pins everything level.
  useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(bob);
      cancelAnimation(sway);
      bob.value = 0;
      sway.value = 0;
      return;
    }

    const bobTravel = size * IDLE_BOB_TRAVEL_FRACTION;
    bob.value = withRepeat(
      withSequence(
        withTiming(-bobTravel, { duration: IDLE_BOB_HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin) }),
        withTiming(bobTravel, { duration: IDLE_BOB_HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    sway.value = withRepeat(
      withSequence(
        withTiming(-IDLE_SWAY_DEGREES, { duration: IDLE_SWAY_HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin) }),
        withTiming(IDLE_SWAY_DEGREES, { duration: IDLE_SWAY_HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );

    return () => {
      cancelAnimation(bob);
      cancelAnimation(sway);
    };
  }, [bob, sway, size, reducedMotion]);

  // Idle swim rides on the outer view; the flip rides on the inner one. The
  // two compose, so the flip launches from wherever the bob happens to be
  // and lands back into it without a visible seam.
  const idleStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bob.value }, { rotate: `${sway.value}deg` }],
  }));

  const flipStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: flipJumpOffset(flipProgress.value, size) },
      { rotate: `${flipRotation(flipProgress.value)}deg` },
      { scale: flipScale(flipProgress.value) },
    ],
  }));

  const handlePress = useCallback(() => {
    // The guard: one flip at a time. The tap still lands for the caller on
    // the first press; mid-flip taps are swallowed entirely.
    if (flipping.value) return;

    haptic('light');
    onPress?.();

    // Reduced motion: acknowledge the tap, skip the travel.
    if (reducedMotion) return;

    flipping.value = true;
    flipProgress.value = 0;
    flipProgress.value = withTiming(
      1,
      { duration: FLIP_DURATION_MS, easing: Easing.inOut(Easing.cubic) },
      () => {
        // Drop the guard — this runs on cancellation too, so a stuck guard
        // can never brick the mascot. Do NOT touch flipProgress here: 360°
        // already reads as level, handlePress zeroes it before each flip,
        // and assigning a shared value from inside its own completion
        // callback cancels the animation → re-enters this callback → stack
        // overflow on the UI thread (seen on device).
        flipping.value = false;
      },
    );
  }, [flipping, flipProgress, onPress, reducedMotion, size]);

  const box = belugaImageBox(size);

  // The mascot itself is decoration — the pressable wrapper (below) carries
  // the accessible role/label/hint, so the image tree is hidden from AT.
  const avatar = (
    <Animated.View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, idleStyle]}>
      <Animated.View style={flipStyle}>
        <Image
          source={BELUGA_CUTOUT}
          style={{ width: box.width, height: box.height }}
          resizeMode="contain"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          accessibilityIgnoresInvertColors
        />
      </Animated.View>
    </Animated.View>
  );

  if (!onPress) {
    // Always animated (idle swim), but not pressable.
    return (
      <View style={style} testID={testID}>
        {avatar}
      </View>
    );
  }

  // Always animated (idle swim) + pressable for the flip.
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Tap to play flip animation"
      hitSlop={theme.layout.hitSlop}
      onPress={handlePress}
      style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, style]}
    >
      {avatar}
    </Pressable>
  );
}
