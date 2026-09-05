// Notification component with carabiner drop animation from top-right.
//
// Whenever Belay shows a notification (NeedsYou toast, banner, or native
// notification UI), the carabiner drops from the top-right with the content.
// Reuses the same carabiner mark as splash for brand consistency.

import React, { useEffect } from 'react';
import { View, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Txt, Caption, useReducedMotion } from './index';
import { Carabiner } from './carabiner';
import { SPRING_CONFIGS } from './motion';

/**
 * Realistic short rope segment with twisted strands and depth.
 */
function RopeSegment({ height = 30, color }: { height?: number; color: string }) {
  const ropeWidth = 4;
  const highlightWidth = ropeWidth * 0.35;
  
  return (
    <View style={{ position: 'relative', width: ropeWidth, height, alignItems: 'center' }}>
      {/* Shadow for depth */}
      <View
        style={{
          position: 'absolute',
          left: 1,
          top: 0,
          width: ropeWidth,
          height,
          backgroundColor: 'rgba(0, 0, 0, 0.15)',
          borderRadius: ropeWidth / 2,
        }}
      />
      {/* Main rope body */}
      <View
        style={{
          width: ropeWidth,
          height,
          backgroundColor: color,
          borderRadius: ropeWidth / 2,
        }}
      />
      {/* Left highlight strand */}
      <View
        style={{
          position: 'absolute',
          left: ropeWidth * 0.15,
          top: 0,
          width: highlightWidth,
          height,
          backgroundColor: 'rgba(255, 255, 255, 0.35)',
          borderRadius: highlightWidth / 2,
        }}
      />
      {/* Right subtle strand */}
      <View
        style={{
          position: 'absolute',
          right: ropeWidth * 0.2,
          top: 0,
          width: highlightWidth * 0.7,
          height,
          backgroundColor: 'rgba(255, 255, 255, 0.15)',
          borderRadius: highlightWidth / 2,
        }}
      />
    </View>
  );
}

export interface NotificationCarabinerProps {
  /** Notification title */
  title: string;
  /** Optional message body */
  message?: string;
  /** Callback when tapped */
  onPress?: () => void;
  /** Callback when dismissed */
  onDismiss?: () => void;
  /** Auto-dismiss after this many ms (default 4000) */
  autoDismissMs?: number;
}

/**
 * Notification that drops from top-right with carabiner and rope.
 * Animates in, shows for a duration, then animates out.
 */
export function NotificationCarabiner({
  title,
  message,
  onPress,
  onDismiss,
  autoDismissMs = 4000,
}: NotificationCarabinerProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();

  const translateY = useSharedValue(reducedMotion ? 0 : -150);
  const opacity = useSharedValue(reducedMotion ? 1 : 0);

  useEffect(() => {
    if (reducedMotion) {
      translateY.value = 0;
      opacity.value = 1;
    } else {
      // Drop in
      translateY.value = withSpring(0, SPRING_CONFIGS.bouncy);
      opacity.value = withTiming(1, { duration: theme.motion.fast });
    }

    // Auto-dismiss
    const timer = setTimeout(() => {
      if (reducedMotion) {
        opacity.value = 0;
      } else {
        translateY.value = withSpring(-150, SPRING_CONFIGS.snappy);
        opacity.value = withTiming(0, { duration: theme.motion.base });
      }
      setTimeout(() => onDismiss?.(), theme.motion.base + 50);
    }, autoDismissMs);

    return () => clearTimeout(timer);
  }, [reducedMotion, translateY, opacity, theme.motion, autoDismissMs, onDismiss]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          top: insets.top + theme.space.sm,
          right: theme.layout.margin,
          alignItems: 'flex-end',
          gap: theme.space.xxs,
          maxWidth: 280,
        },
        animatedStyle,
      ]}
    >
      {/* Rope segment */}
      <View style={{ alignItems: 'center' }}>
        <RopeSegment height={20} color={theme.colors.accentGraphic} />
      </View>

      {/* Carabiner */}
      <View style={{ alignItems: 'center', marginTop: -8 }}>
        <Carabiner size={24} strokeWidth={2.5} color={theme.colors.accentGraphic} />
      </View>

      {/* Notification content card */}
      <Pressable
        onPress={() => {
          onPress?.();
          onDismiss?.();
        }}
        style={({ pressed }) => ({
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.sm,
          borderWidth: theme.layout.hairline,
          borderColor: theme.colors.border,
          padding: theme.space.md,
          gap: theme.space.xxs,
          opacity: pressed ? theme.motion.pressOpacity : 1,
          // Shadow for lift
          shadowColor: theme.colors.shadow,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.2,
          shadowRadius: 8,
          elevation: 4,
        })}
        accessibilityRole="button"
        accessibilityLabel={`Notification: ${title}`}
      >
        <Txt variant="bodyStrong" numberOfLines={2}>
          {title}
        </Txt>
        {message ? (
          <Caption numberOfLines={3}>
            {message}
          </Caption>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

/**
 * Hook to show notification carabiner. Returns a function to show notifications.
 * Usage:
 * 
 * const showNotification = useNotificationCarabiner();
 * showNotification({ title: 'Task complete', message: 'Your file finished uploading' });
 */
export function useNotificationCarabiner() {
  // This would integrate with a notification state management system
  // For now, returns a placeholder function
  return (props: Omit<NotificationCarabinerProps, 'onDismiss'>) => {
    // Implementation would add notification to a queue/stack
    console.log('Show notification:', props);
  };
}
