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
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import type { Palette } from '../theme';
import { useLook } from '../design/use-look';
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
    // The fill is `ctaBottom`: the flat looks set both CTA ends to `accent`,
    // Harbour paints the lantern-amber gradient over it (<CtaFill>).
    primary: {
      background: c.ctaBottom,
      foreground: c.onCta,
      border: 'transparent',
      disabledBackground: c.accentDim,
      pressedBackground: c.accentPress,
    },
    danger: { background: c.bad, foreground: c.onDanger, border: 'transparent' },
    // Hairline-outlined in ink — the strongest non-accent button.
    // Under a look with depth (Harbour) it is a soft cloud pill instead: the
    // card fill, a quiet rule and the sea shadow.
    secondary: c.depth === 'none'
      ? { background: 'transparent', foreground: c.text, border: c.borderStrong }
      : { background: c.surface, foreground: c.text, border: c.border },
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
/** Harbour's lantern glow and lift under the amber pill (site .setup-pill). */
const CTA_GLOW = '0px 0px 22px -6px rgba(255, 203, 126, 0.7), 0px 14px 22px -14px rgba(150, 100, 40, 0.45)';

/**
 * The lantern-amber body of Harbour's primary pill: the top-to-bottom amber,
 * then the site's sheen fading out above the words. Drawn behind the label,
 * clipped to the pill, invisible to touch and assistive tech.
 */
function CtaFill({ top, bottom }: { top: string; bottom: string }) {
  return (
    <View pointerEvents="none" accessibilityElementsHidden style={[StyleSheet.absoluteFill, { borderRadius: 999, overflow: 'hidden' }]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="belay-cta" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={top} />
            <Stop offset="1" stopColor={bottom} />
          </LinearGradient>
          <LinearGradient id="belay-cta-sheen" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.55} />
            <Stop offset="0.42" stopColor="#FFFFFF" stopOpacity={0.16} />
            <Stop offset="0.52" stopColor="#FFFFFF" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#belay-cta)" />
        <Rect width="100%" height="100%" fill="url(#belay-cta-sheen)" />
      </Svg>
    </View>
  );
}

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
  const look = useLook();
  const inactive = disabled || loading;
  const v = variantStyle(variant, theme.colors);
  const s = SIZES[size];
  // Harbour's amber pill: a real gradient only when the look paints one.
  const gradient = variant === 'primary' && !inactive && theme.colors.ctaTop !== theme.colors.ctaBottom;
  const raised = theme.colors.depth !== 'none' && (variant === 'primary' || variant === 'secondary') && !inactive;

  const handlePress = useCallback(() => {
    if (inactive) return;
    const tone = hapticTone === undefined ? DEFAULT_TONE[variant] : hapticTone;
    if (tone) haptic(tone);
    onPress();
  }, [inactive, hapticTone, variant, onPress]);

  // `type.button`, not `type.label`: a button's word carries a 44pt slab and
  // both concept mockups set it at 15/600. `label` stays the quiet 13pt row
  // marker it is everywhere else.
  const labelStyle: TextStyle = {
    ...(theme.type.button as TextStyle),
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
          borderRadius: look.controlRadius,
          boxShadow: raised ? (variant === 'primary' ? CTA_GLOW : theme.colors.depth) : undefined,
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
        <>
        {gradient && !pressed ? <CtaFill top={theme.colors.ctaTop} bottom={theme.colors.ctaBottom} /> : null}
        {loading ? (
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
        )}
        </>
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
