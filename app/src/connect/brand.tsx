// Wordmark and logo for the connect screen. Drawn from Views so there is no
// image to decode and it recolours with the theme.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Heading, Sub } from '../ui';

/** The tether: a filled square linked to an outlined one. */
export function LogoMark({ size = 66 }: { size?: number }) {
  const theme = useTheme();
  const inner = Math.round(size * 0.4);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: theme.colors.accent,
        alignItems: 'center',
        justifyContent: 'center',
        ...theme.elevation.md,
        shadowColor: theme.colors.accent,
      }}
    >
      <View
        style={{
          width: inner,
          height: inner,
          borderRadius: Math.round(inner * 0.3),
          borderWidth: Math.max(3, Math.round(size * 0.06)),
          borderColor: theme.colors.onAccent,
        }}
      />
    </View>
  );
}

/** Logo plus name and one-line pitch, centred. */
export function Brand() {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center' }}>
      <LogoMark />
      <Heading style={{ marginTop: theme.space.sm }}>Tether</Heading>
      <Sub style={{ textAlign: 'center', marginTop: theme.space.xxs }}>
        Your computer, on your phone.
      </Sub>
    </View>
  );
}
