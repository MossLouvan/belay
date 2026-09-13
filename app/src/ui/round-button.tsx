// The 36pt round chrome button both concept mockups park in a header corner:
// a filled grey disc in Current, a hairline-outlined disc in Fieldwork.
//
// Separate from `IconButton` because that primitive is square-cornered chrome
// tuned for toolbars. This one is always a circle, always the same diameter,
// and always keeps the 44pt touch target via hitSlop rather than by growing —
// a 44pt disc is visibly a bubble next to a 24pt wordmark.

import React, { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { haptic } from './haptics';

/** Drawn diameter. The touch target is topped up to 44pt with hitSlop. */
export const ROUND_BUTTON_SIZE = 36;

export type RoundButtonVariant = 'filled' | 'outline' | 'plain';

export interface RoundButtonProps {
  /** Required: an icon-only control is meaningless to a screen reader. */
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly children: React.ReactNode;
  readonly variant?: RoundButtonVariant;
  readonly disabled?: boolean;
  readonly testID?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export function RoundButton({
  accessibilityLabel, onPress, children, variant = 'filled', disabled = false, testID, style,
}: RoundButtonProps) {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    if (disabled) return;
    haptic('light');
    onPress();
  }, [disabled, onPress]);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={handlePress}
      hitSlop={theme.layout.hitSlop}
      style={({ pressed }) => [
        {
          width: ROUND_BUTTON_SIZE,
          height: ROUND_BUTTON_SIZE,
          borderRadius: ROUND_BUTTON_SIZE / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: variant === 'filled' ? theme.colors.surfaceAlt : 'transparent',
          borderWidth: variant === 'outline' ? theme.layout.hairline : 0,
          borderColor: theme.colors.borderStrong,
          opacity: disabled ? 0.45 : pressed ? theme.motion.pressOpacity : 1,
        },
        style,
      ]}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{children}</View>
    </Pressable>
  );
}
