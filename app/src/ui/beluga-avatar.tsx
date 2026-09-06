// The Belay beluga mascot — cohesive identity across stream HUD and tools drawer.
//
// Press triggers a flip + splash animation (Reanimated transform sequence) —
// pure personality chrome, no functional meaning. One avatar component, two
// sizes: 48px circular top-right on the stream, 40px in the drawer header.
//
// TODO: Replace flip animation with actual beluga-flip-splash.mp4 video once
// the asset is supplied. The current implementation uses a Reanimated 3D flip
// as a placeholder — the final design calls for a looping water-splash clip.

import React, { useCallback } from 'react';
import { Image, Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { haptic } from './haptics';

export interface BelugaAvatarProps {
  /** Avatar size in pixels (diameter of the circle). */
  size: number;
  /** Optional press handler. If omitted, the avatar is not pressable. */
  onPress?: () => void;
  /** Background color behind the circular crop. */
  backgroundColor?: string;
  /** Accessibility label. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The Belay beluga mascot: circular avatar with optional press animation.
 * Used in the stream HUD (48px, top-right) and tools drawer header (40px).
 *
 * Press plays a flip animation once, then settles back to still. The animation
 * is a 3D Y-axis rotation placeholder — the final design will use a short
 * video clip (beluga-flip-splash.mp4) once supplied.
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
  const flipRotation = useSharedValue(0);

  const playFlipAnimation = useCallback(() => {
    haptic('light');
    onPress?.();
    
    // Flip animation: rotate 360° on Y-axis (flip forward, settle back)
    // Duration: 600ms total (fast flip, smooth settle)
    flipRotation.value = withSequence(
      withTiming(180, { duration: 300, easing: Easing.out(Easing.cubic) }),
      withTiming(360, { duration: 300, easing: Easing.in(Easing.cubic) }),
      withTiming(0, { duration: 0 }) // Reset for next play
    );
  }, [flipRotation, onPress]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotateY: `${flipRotation.value}deg` }],
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
    // Static, non-interactive avatar
    return <View style={style} testID={testID}>{avatar}</View>;
  }

  // Pressable avatar with animation
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Play a flip animation"
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
