// Glass panel component — soft translucent surfaces with hairline borders.
// Inspired by premium SaaS UIs (Linear, Vercel, Grok Bot) for the Belay redesign.
//
// Usage: Wrap content in <GlassPanel> for cards, modals, elevated surfaces.
// Automatically handles dark theme with subtle borders and soft backgrounds.

import React from 'react';
import { View, ViewProps } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface GlassPanelProps extends Omit<ViewProps, 'style'> {
  /** Children to render inside the panel */
  children: React.ReactNode;
  /** Visual elevation level — controls opacity and border subtlety */
  elevation?: 'low' | 'medium' | 'high';
  /** Whether to add padding inside the panel */
  padded?: boolean;
  /** Custom padding override */
  padding?: number;
  /** Additional styles */
  style?: StyleProp<ViewStyle>;
}

/**
 * Premium glass panel with soft translucent background and hairline border.
 * The Grok Bot-inspired component for elevated surfaces.
 * 
 * Elevation levels:
 * - low: subtle lift, barely-there border (list items, rows)
 * - medium: standard panel (cards, sections) 
 * - high: prominent panel (modals, sheets, CTAs)
 */
export function GlassPanel({
  children,
  elevation = 'medium',
  padded = true,
  padding,
  style,
  ...rest
}: GlassPanelProps) {
  const theme = useTheme();

  // Elevation determines background opacity and border visibility
  const elevationStyles: Record<NonNullable<GlassPanelProps['elevation']>, ViewStyle> = {
    low: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.border,
      borderWidth: theme.layout.hairline,
    },
    medium: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.borderStrong,
      borderWidth: theme.layout.hairline,
    },
    high: {
      backgroundColor: theme.colors.sheet,
      borderColor: theme.colors.borderStrong,
      borderWidth: theme.layout.hairline * 1.5,
    },
  };

  const paddingValue = padding ?? (padded ? theme.space.md : 0);

  return (
    <View
      {...rest}
      style={[
        {
          borderRadius: theme.radius.md,
          padding: paddingValue,
        },
        elevationStyles[elevation],
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Floating pill CTA — inspired by Grok Bot's white pill buttons.
 * For prominent primary actions on dark backgrounds.
 */
export interface PillCTAProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  style?: StyleProp<ViewStyle>;
}

export function PillCTA({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
  style,
}: PillCTAProps) {
  const theme = useTheme();

  const variantStyles: Record<NonNullable<PillCTAProps['variant']>, ViewStyle> = {
    primary: {
      backgroundColor: theme.colors.text, // white pill on dark
      borderColor: 'transparent',
    },
    secondary: {
      backgroundColor: 'transparent',
      borderColor: theme.colors.borderStrong,
      borderWidth: theme.layout.hairline,
    },
  };

  return (
    <View
      style={[
        {
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm,
          borderRadius: 999, // pill shape
          alignItems: 'center',
          justifyContent: 'center',
        },
        variantStyles[variant],
        style,
      ]}
    >
      {/* Implementation would include text + press handling */}
    </View>
  );
}
