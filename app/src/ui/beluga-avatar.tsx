// The Belay beluga mascot — cohesive identity across stream HUD and tools drawer.
//
// This is the CUTOUT era: `beluga-cutout.png` is a transparent RGBA cutout
// (642x537, rope collar + carabiner intact), so the mascot floats directly on
// whatever surface hosts it. No circle, no water, no video — the old
// expo-video swim/flip clips are retired and deleted along with the
// dependency (see assets/BELUGA-ASSETS.md).
//
// IDLE (default, always, unless reduced motion):
//   - A slow vertical bob + a subtle rotational sway, phase-offset so the
//     two never sync up — reads as treading water, not a metronome.
//
// ON PRESS (click/tap) — a fidget toy, not a one-shot clip:
//   - Every tap ADDS angular velocity. One tap is one clean flip with a hop
//     and an apex swell; rapid taps wind the beluga up faster and faster
//     (capped), the hop lifting into a hover that grows with speed. Stop
//     tapping and friction bleeds it off, steering the last turn onto level
//     so the idle sway carries on without a seam. Haptics climb with speed.
//   - `onPress` fires on EVERY tap — callers own their own debouncing.
//   - Reduced motion: no travel at all; `onPress` and a light haptic still fire.
//
// The spin is a pure model (./beluga-motion.ts, tested) integrated by a
// Reanimated frame callback on the UI thread. Nothing here drives a shared
// value from inside its own animation callback — that pattern cancels the
// animation, re-enters the callback and overflows the UI-thread stack (seen
// on device). A frame callback has no completion callback to trip over.

import React, { useCallback, useEffect, useRef } from 'react';
import { Image, Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useFrameCallback,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  cancelAnimation,
  runOnJS,
  runOnUI,
} from 'react-native-reanimated';
import type { FrameCallback, FrameInfo } from 'react-native-reanimated';
import { useTheme } from '../theme';
import { haptic } from './haptics';
import { useReducedMotion } from './motion';
import {
  belugaImageBox,
  isSpinIdle,
  spinHapticTier,
  spinJumpOffset,
  spinRotation,
  spinScale,
  stepSpin,
  tapSpin,
  IDLE_BOB_HALF_CYCLE_MS,
  IDLE_BOB_TRAVEL_FRACTION,
  IDLE_SWAY_HALF_CYCLE_MS,
  IDLE_SWAY_DEGREES,
  SPIN_AT_REST,
} from './beluga-motion';
import type { SpinHapticTier, SpinState } from './beluga-motion';

const BELUGA_CUTOUT = require('../../assets/beluga-cutout.png');

const MS_PER_SECOND = 1000;

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
 * PRESS: taps add spin momentum; friction winds it down onto level.
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
  // The spin: one immutable state, replaced (never mutated) every frame.
  const spin = useSharedValue<SpinState>(SPIN_AT_REST);

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

  // The spin integrator. Runs only while there is momentum to spend: the
  // tap switches it on (JS side), and the frame that lands the beluga
  // switches it off again via runOnJS — the one place JS is involved.
  const spinFramesRef = useRef<FrameCallback | null>(null);
  const stopIntegrating = useCallback(() => {
    spinFramesRef.current?.setActive(false);
  }, []);
  const integrate = useCallback(
    (frame: FrameInfo) => {
      'worklet';
      const dt = (frame.timeSincePreviousFrame ?? 0) / MS_PER_SECOND;
      const next = stepSpin(spin.value, dt);
      spin.value = next;
      if (isSpinIdle(next)) runOnJS(stopIntegrating)();
    },
    [spin, stopIntegrating],
  );
  const spinFrames = useFrameCallback(integrate, false);
  useEffect(() => {
    spinFramesRef.current = spinFrames;
  }, [spinFrames]);

  // Reduced motion (or a switch to it mid-spin) drops the beluga level.
  useEffect(() => {
    if (!reducedMotion) return;
    spinFrames.setActive(false);
    spin.value = SPIN_AT_REST;
  }, [reducedMotion, spin, spinFrames]);

  // A tap has landed on the model (on the UI thread): buzz to match the new
  // speed and make sure the integrator is running.
  const onSpinTapped = useCallback(
    (tier: SpinHapticTier) => {
      haptic(tier);
      spinFrames.setActive(true);
    },
    [spinFrames],
  );

  const handlePress = useCallback(() => {
    // Every tap reaches the caller — the momentum model has no guard, and
    // the Screen view debounces its orientation latch on its own terms.
    onPress?.();

    // Reduced motion: acknowledge the tap, skip the travel.
    if (reducedMotion) {
      haptic('light');
      return;
    }

    // The tap is applied where the integrator lives, so it always stacks
    // onto the velocity of THIS frame rather than a stale JS-side copy.
    runOnUI(() => {
      'worklet';
      const next = tapSpin(spin.value);
      spin.value = next;
      runOnJS(onSpinTapped)(spinHapticTier(next.velocity));
    })();
  }, [onPress, onSpinTapped, reducedMotion, spin]);

  // Idle swim rides on the outer view; the spin rides on the inner one. The
  // two compose, so the spin launches from wherever the bob happens to be
  // and lands back into it without a visible seam.
  const idleStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bob.value }, { rotate: `${sway.value}deg` }],
  }));

  const spinStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: spinJumpOffset(spin.value, size) },
      { rotate: `${spinRotation(spin.value)}deg` },
      { scale: spinScale(spin.value) },
    ],
  }));

  const box = belugaImageBox(size);

  // The mascot itself is decoration — the pressable wrapper (below) carries
  // the accessible role/label/hint, so the image tree is hidden from AT.
  const avatar = (
    <Animated.View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, idleStyle]}>
      <Animated.View style={spinStyle}>
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

  // Always animated (idle swim) + pressable for the spin.
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Tap to spin; keep tapping to spin faster"
      hitSlop={theme.layout.hitSlop}
      onPress={handlePress}
      style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, style]}
    >
      {avatar}
    </Pressable>
  );
}
