// Pressable primitives. Every one of these guarantees a 44pt touch target,
// a screen-reader role/state, a press animation and an optional haptic.

import React, { useCallback } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';
import { Palette, useTheme } from '../theme';
import { haptic, HapticTone } from './haptics';
import { usePressScale } from './motion';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface VariantStyle {
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
}

const variantStyle = (variant: ButtonVariant, c: Palette): VariantStyle => {
  const styles: Record<ButtonVariant, VariantStyle> = {
    primary: { background: c.accent, foreground: c.onAccent, border: 'transparent' },
    danger: { background: c.bad, foreground: c.onDanger, border: 'transparent' },
    secondary: { background: c.surfaceAlt, foreground: c.text, border: c.borderStrong },
    // `onAccentSoft`, not `accent`: the fill is translucent, so the label sits
    // on accentSoft composited over the host surface, where solid `accent`
    // falls under 4.5:1. See the `on*Soft` note in theme.ts.
    subtle: { background: c.accentSoft, foreground: c.onAccentSoft, border: 'transparent' },
    ghost: { background: 'transparent', foreground: c.text, border: c.borderStrong },
  };
  return styles[variant];
};

interface SizeStyle {
  readonly minHeight: number;
  readonly paddingHorizontal: number;
  readonly fontSize: number;
  readonly gap: number;
}

const SIZES: Readonly<Record<ButtonSize, SizeStyle>> = {
  sm: { minHeight: 44, paddingHorizontal: 14, fontSize: 14, gap: 6 },
  md: { minHeight: 48, paddingHorizontal: 18, fontSize: 15, gap: 8 },
  lg: { minHeight: 56, paddingHorizontal: 22, fontSize: 17, gap: 10 },
};

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  /** Leading element, typically a glyph. Hidden from screen readers. */
  icon?: React.ReactNode;
  fullWidth?: boolean;
  /** Haptic fired on press. `null` disables it. Defaults by variant. */
  hapticTone?: HapticTone | null;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const DEFAULT_TONE: Readonly<Record<ButtonVariant, HapticTone>> = {
  primary: 'medium',
  danger: 'warning',
  secondary: 'light',
  subtle: 'light',
  ghost: 'light',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  fullWidth,
  hapticTone,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ButtonProps) {
  const theme = useTheme();
  const press = usePressScale();
  const inactive = disabled || loading;
  const v = variantStyle(variant, theme.colors);
  const s = SIZES[size];

  const handlePress = useCallback(() => {
    if (inactive) return;
    const tone = hapticTone === undefined ? DEFAULT_TONE[variant] : hapticTone;
    if (tone) haptic(tone);
    onPress();
  }, [inactive, hapticTone, variant, onPress]);

  return (
    <Animated.View style={[{ transform: [{ scale: press.scale }] }, fullWidth && { alignSelf: 'stretch' }, style]}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: inactive, busy: loading }}
        disabled={inactive}
        onPress={handlePress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => ({
          backgroundColor: v.background,
          borderColor: v.border,
          borderWidth: theme.layout.hairline,
          borderRadius: theme.radius.md,
          minHeight: s.minHeight,
          paddingHorizontal: s.paddingHorizontal,
          paddingVertical: theme.space.sm,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: s.gap,
          opacity: inactive ? 0.45 : pressed ? 0.9 : 1,
        })}
      >
        {loading ? (
          <ActivityIndicator color={v.foreground} accessibilityElementsHidden />
        ) : (
          <>
            {icon ? <View accessibilityElementsHidden>{icon}</View> : null}
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1.4}
              style={{ color: v.foreground, fontWeight: '700', fontSize: s.fontSize, letterSpacing: 0.1 }}
            >
              {label}
            </Text>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

export interface IconButtonProps {
  /** Required: an icon-only control is meaningless to a screen reader without it. */
  accessibilityLabel: string;
  onPress: () => void;
  children: React.ReactNode;
  variant?: 'plain' | 'surface' | 'accent' | 'danger';
  size?: number;
  disabled?: boolean;
  selected?: boolean;
  hapticTone?: HapticTone | null;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  accessibilityLabel,
  onPress,
  children,
  variant = 'surface',
  size,
  disabled = false,
  selected,
  hapticTone = 'light',
  accessibilityHint,
  testID,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  const press = usePressScale();
  const dimension = Math.max(theme.layout.minTouch, size ?? theme.layout.minTouch);

  const fills: Record<NonNullable<IconButtonProps['variant']>, string> = {
    plain: 'transparent',
    surface: theme.colors.surfaceAlt,
    accent: theme.colors.accentSoft,
    danger: theme.colors.badSoft,
  };

  const handlePress = useCallback(() => {
    if (disabled) return;
    if (hapticTone) haptic(hapticTone);
    onPress();
  }, [disabled, hapticTone, onPress]);

  return (
    <Animated.View style={[{ transform: [{ scale: press.scale }] }, style]}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled, selected }}
        disabled={disabled}
        onPress={handlePress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        hitSlop={theme.layout.hitSlop}
        style={({ pressed }) => ({
          width: dimension,
          height: dimension,
          borderRadius: theme.radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: selected ? theme.colors.accentSoft : fills[variant],
          borderWidth: variant === 'plain' ? 0 : theme.layout.hairline,
          borderColor: theme.colors.border,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        })}
      >
        <View accessibilityElementsHidden>{children}</View>
      </Pressable>
    </Animated.View>
  );
}
