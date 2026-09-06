// The Belay beluga mascot — cohesive identity across stream HUD and tools drawer.
//
// IDLE (default, always):
//   - Always animated with Reanimated subtle bob/float/breathe on PNG (never frozen still).
//   - Loops seamlessly while visible (no flip, no splash in idle).
//   - Implementation: 2px Y-axis bob, 2s cycle, smooth sine easing.
//   - Optional future: swap to `beluga-idle.mp4` if credits allow.
//
// ON PRESS (click/tap):
//   - Play flip + splash animation once, then return to idle loop.
//   - Implementation: 360° Y-axis rotation (600ms) as placeholder.
//   - TODO: Replace with `beluga-flip-splash.mp4` (silent) once generated.
//   - Pressable API ready for video drop-in.
//
// Credit-constrained: Idle stays Reanimated; flip video prioritized (7.5 credits).

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

export interface BelugaAvatarProps {
  /** Avatar size in pixels (diameter of the circle). */
  size: number;
  /** Optional press handler. If omitted, the avatar is still animated but not pressable. */
  onPress?: () => void;
  /** Background color behind the circular crop. */
  backgroundColor?: string;
  /** Accessibility label. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The Belay beluga mascot: always-animated circular avatar.
 * Used in the stream HUD (48px, top-right) and tools drawer header (40px).
 *
 * IDLE: Continuous subtle bob animation (seamless loop).
 * PRESS: Plays flip animation once, then returns to idle loop.
 *
 * Current: Reanimated placeholders. Final: Video components for idle + flip.
 */
export function BelugaAvatar({
  size,
  onPress,
  backgroundColor,
  accessibilityLabel = 'Belay mascot',
  style,
  testID,
}: BelugaAvatarProps) {
  const theme = useTheme();
  const idleBob = useSharedValue(0);
  const flipRotation = useSharedValue(0);
  const isFlipping = useSharedValue(false);

  // Idle animation: continuous subtle bob (2px up/down, 2s cycle)
  useEffect(() => {
    idleBob.value = withRepeat(
      withSequence(
        withTiming(-2, { duration: 1000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 1000, easing: Easing.inOut(Easing.sin) })
      ),
      -1, // infinite
      false // don't reverse
    );

    return () => {
      cancelAnimation(idleBob);
    };
  }, [idleBob]);

  const playFlipAnimation = useCallback(() => {
    if (isFlipping.value) return; // Prevent double-taps during flip
    
    haptic('light');
    onPress?.();
    isFlipping.value = true;
    
    // Flip animation: rotate 360° on Y-axis, then return to idle
    // Duration: 600ms total (fast flip, smooth settle)
    flipRotation.value = withSequence(
      withTiming(180, { duration: 300, easing: Easing.out(Easing.cubic) }),
      withTiming(360, { duration: 300, easing: Easing.in(Easing.cubic) }),
      withTiming(0, { duration: 0 }) // Reset for next play
    );
    
    // Re-enable flipping after animation completes
    setTimeout(() => {
      isFlipping.value = false;
    }, 600);
  }, [flipRotation, isFlipping, onPress]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: idleBob.value }, // Idle bob (always active)
      { rotateY: `${flipRotation.value}deg` }, // Flip (on press)
    ],
  }));

  const avatar = (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: backgroundColor ?? theme.colors.surfaceAlt,
          overflow: 'hidden',
        },
        animatedStyle,
      ]}
    >
      <Image
        source={require('../../assets/beluga-mascot.jpg')}
        style={{ width: size, height: size }}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
      />
    </Animated.View>
  );

  if (!onPress) {
    // Always animated (idle loop), but not pressable
    return <View style={style} testID={testID}>{avatar}</View>;
  }

  // Always animated (idle loop) + pressable for flip animation
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Tap to play flip animation"
      hitSlop={theme.layout.hitSlop}
      onPress={playFlipAnimation}
      style={({ pressed }) => [
        {
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {avatar}
    </Pressable>
  );
}
