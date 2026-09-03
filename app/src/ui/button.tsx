// Pressable primitives. Every one of these guarantees a 44pt touch target,
// a screen-reader role/state, press feedback and an optional haptic.
//
// Ledger rules applied here: at most one solid accent button per screen (the
// primary action — the accent must be earned, docs/DESIGN.md §3.3); everything
// else is a text button or a hairline-outlined button in ink. Labels are set
// in the wide-tracked mono micro-label — buttons speak in the same voice as
// the section markers. Press feedback is opacity, never scale: editorial
// surfaces do not squish (§10).

import React, { useCallback } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import type { Palette } from '../theme';
import { haptic } from './haptics';
import type { HapticTone } from './haptics';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface VariantStyle {
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
  /** Disabled state keeps its own fill so a dimmed solid never fakes depth. */
  readonly disabledBackground?: string;
  /** Solid fills darken under load instead of ghosting (REVAMP-SPEC §5.10):
   *  when set, press feedback is this fill at full opacity — the rope taking
   *  weight — and the opacity dip is suppressed for the variant. */
  readonly pressedBackground?: string;
}

const variantStyle = (variant: ButtonVariant, c: Palette): VariantStyle => {
  const styles: Record<ButtonVariant, VariantStyle> = {
    // The one solid accent fill the system allows; disabled drops to the
    // accentDim track tint rather than a translucent whole-button fade, so a
    // disabled primary still reads as "the primary, currently unavailable".
    // Pressed, the fill deepens to `accentPress` (REVAMP-SPEC §5.10: "fills
    // darken under load") — a solid never turns translucent mid-press.
    primary: {
      background: c.accent,
      foreground: c.onAccent,
      border: 'transparent',
      disabledBackground: c.accentDim,
      pressedBackground: c.accentPress,
    },
    danger: { background: c.bad, foreground: c.onDanger, border: 'transparent' },
    // Hairline-outlined in ink — the strongest non-accent button.
    secondary: { background: 'transparent', foreground: c.text, border: c.borderStrong },
    // `onAccentSoft`, not `accent`: the fill is translucent, so the label sits
    // on accentSoft composited over the host surface, where solid `accent`
    // falls under 4.5:1. See the `on*Soft` note in theme.ts.
    subtle: { background: c.accentSoft, foreground: c.onAccentSoft, border: 'transparent' },
    // The quiet text button: no box, so under the track rule (docs/DESIGN.md
    // §11.1) it must carry the 2pt resting track — its label style alone is
    // indistinguishable from a section marker, which is exactly how "REFRESH"
    // and "DONE" became invisible. The track is drawn in the render below.
    ghost: { background: 'transparent', foreground: c.text, border: 'transparent' },
  };
  return styles[variant];
};

interface SizeStyle {
  readonly minHeight: number;
  readonly paddingHorizontal: number;
  readonly gap: number;
}

// Font size does not vary with button size: every button label is the 11pt
// tracked mono micro-label, and `label` never exceeds 11pt (docs/DESIGN.md
// §4.3). Bigger buttons buy presence with height, not louder type.
//
// Height discipline per REVAMP-SPEC §5.10: sm 36 / md 44. The 44pt touch
// target survives via hitSlop on any size shorter than `layout.minTouch`.
const SIZES: Readonly<Record<ButtonSize, SizeStyle>> = {
  sm: { minHeight: 36, paddingHorizontal: 14, gap: 6 },
  md: { minHeight: 44, paddingHorizontal: 18, gap: 8 },
  lg: { minHeight: 56, paddingHorizontal: 22, gap: 10 },
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
  const inactive = disabled || loading;
  const v = variantStyle(variant, theme.colors);
  const s = SIZES[size];

  const handlePress = useCallback(() => {
    if (inactive) return;
    const tone = hapticTone === undefined ? DEFAULT_TONE[variant] : hapticTone;
    if (tone) haptic(tone);
    onPress();
  }, [inactive, hapticTone, variant, onPress]);

  const labelStyle: TextStyle = {
    ...(theme.type.label as TextStyle),
    color: v.foreground,
  };

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={handlePress}
      // sm buttons stand 36pt tall (REVAMP-SPEC §5.10); hitSlop restores the
      // 44pt touch target this file's header promises.
      hitSlop={s.minHeight < theme.layout.minTouch ? theme.layout.hitSlop : undefined}
      style={({ pressed }) => [
        {
          backgroundColor:
            inactive && v.disabledBackground
              ? v.disabledBackground
              : pressed && v.pressedBackground
                ? v.pressedBackground
                : v.background,
          borderColor: v.border,
          borderWidth: v.border === 'transparent' ? 0 : theme.layout.hairline,
          borderRadius: theme.radius.xs,
          minHeight: s.minHeight,
          paddingHorizontal: s.paddingHorizontal,
          paddingVertical: theme.space.sm,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: s.gap,
          // Opacity ghosting is for text/label/ghost speech only; a variant
          // with a pressed fill darkens instead of fading (REVAMP-SPEC §5.10:
          // solid fills darken under load, they never go translucent).
          opacity:
            inactive && !v.disabledBackground
              ? 0.45
              : pressed && !v.pressedBackground
                ? theme.motion.pressOpacity
                : 1,
        },
        fullWidth && { alignSelf: 'stretch' },
        style,
      ]}
    >
      {({ pressed }) =>
        loading ? (
          <ActivityIndicator color={v.foreground} accessibilityElementsHidden />
        ) : (
          <>
            {icon ? <View accessibilityElementsHidden>{icon}</View> : null}
            {variant === 'ghost' ? (
              // The track rule's mark — the rope: slack granite `trackRest`
              // at rest, taking load (`accentGraphic`) under the pressing
              // finger (REVAMP-SPEC §6.3, §3.5). Under the label only, not
              // the padded box — this is a tracked word, not a rule.
              <View style={{ alignItems: 'center' }}>
                <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={labelStyle}>
                  {label}
                </Text>
                <View
                  accessibilityElementsHidden
                  style={{
                    alignSelf: 'stretch',
                    height: theme.layout.ruleEmphasis,
                    marginTop: theme.space.xxs,
                    backgroundColor: pressed ? theme.colors.accentGraphic : theme.colors.trackRest,
                  }}
                />
              </View>
            ) : (
              <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={labelStyle}>
                {label}
              </Text>
            )}
          </>
        )
      }
    </Pressable>
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

/**
 * A bare-glyph control. Under the discoverability doctrine (docs/DESIGN.md
 * §11.1) this is only legitimate for the platform-universal five — back,
 * close, add, search, overflow — in the corner/trailing spots where those
 * conventionally live; anything else should be a labelled Button.
 */
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
  const dimension = Math.max(theme.layout.minTouch, size ?? theme.layout.minTouch);

  // No filled icon blobs: `surface` keeps only its hairline outline, and the
  // soft tints remain for the two states that carry meaning.
  const fills: Record<NonNullable<IconButtonProps['variant']>, string> = {
    plain: 'transparent',
    surface: 'transparent',
    accent: theme.colors.accentSoft,
    danger: theme.colors.badSoft,
  };

  const handlePress = useCallback(() => {
    if (disabled) return;
    if (hapticTone) haptic(hapticTone);
    onPress();
  }, [disabled, hapticTone, onPress]);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={handlePress}
      hitSlop={theme.layout.hitSlop}
      style={({ pressed }) => [
        {
          width: dimension,
          height: dimension,
          borderRadius: theme.radius.xs,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: selected ? theme.colors.accentSoft : fills[variant],
          borderWidth: variant === 'surface' ? theme.layout.hairline : 0,
          borderColor: theme.colors.border,
          opacity: disabled ? 0.45 : pressed ? theme.motion.pressOpacity : 1,
        },
        style,
      ]}
    >
      <View accessibilityElementsHidden>{children}</View>
    </Pressable>
  );
}
