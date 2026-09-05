// Premium status badge — text-first, no traffic-light dots.
//
// Replaces green/red dot pattern with clean text pills inspired by Grok Bot's
// subtle status chips (e.g. "Done" pill in the UI). Connection state is text
// + subtle background, never color-coded dots.
//
// Philosophy: State should be readable as TEXT first. Color is accent, not
// carrier. Matches the premium SaaS pattern where status is typographic.

import React, { useEffect } from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { Micro } from './text';

export type StatusBadgeVariant = 'default' | 'subtle' | 'quiet';

export interface StatusBadgeProps {
  /** The status text to display (e.g. "Connected", "Offline", "Reconnecting") */
  label: string;
  /** Visual treatment */
  variant?: StatusBadgeVariant;
  /** Optional trailing content (e.g. detail text, icon) */
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Premium status badge with text-first design. No color-coded dots.
 * 
 * Used for connection status throughout the app:
 * - "Connected" (steady state)
 * - "Offline" (disconnected)
 * - "Reconnecting" (transitioning)
 * 
 * Visual variants:
 * - default: subtle glass pill with hairline border (primary status)
 * - subtle: text only, no background (inline status)
 * - quiet: muted text, minimal (secondary status)
 */
export function StatusBadge({
  label,
  variant = 'default',
  trailing,
  style,
  testID,
}: StatusBadgeProps) {
  const theme = useTheme();

  if (variant === 'subtle' || variant === 'quiet') {
    // Text-only treatment for inline status
    return (
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xs }, style]} testID={testID}>
        <Micro tone={variant === 'quiet' ? 'faint' : 'dim'}>{label}</Micro>
        {trailing}
      </View>
    );
  }

  // Default: subtle glass pill with hairline border
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.xs,
          paddingHorizontal: theme.space.xs,
          paddingVertical: theme.space.xxs,
          borderRadius: theme.radius.xs,
          backgroundColor: theme.colors.surfaceAlt,
          borderWidth: theme.layout.hairline,
          borderColor: theme.colors.border,
        },
        style,
      ]}
      testID={testID}
    >
      <Micro>{label}</Micro>
      {trailing}
    </View>
  );
}

/**
 * Animated ring indicator for transitioning states (Reconnecting, Opening).
 * Subtle, monochrome — no color coding. Spins continuously while visible.
 */
export function TransitionRing({ size = 8 }: { size?: number }) {
  const theme = useTheme();
  const rotation = useSharedValue(0);

  useEffect(() => {
    // Continuous rotation: 0 → 360 over 1 second, looping
    rotation.value = withRepeat(
      withTiming(360, { duration: 1000, easing: Easing.linear }),
      -1, // infinite
      false // don't reverse
    );
    return () => {
      // Cancel animation on unmount
      cancelAnimation(rotation);
    };
  }, [rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      accessibilityElementsHidden
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: theme.colors.textDim,
          borderTopColor: 'transparent', // Gap to show rotation
          opacity: 0.6,
        },
        animatedStyle,
      ]}
    />
  );
}
