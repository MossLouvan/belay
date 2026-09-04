// Wordmark and logo for the connect screen. Drawn from Views so there is no
// image to decode and it recolours with the theme.
//
// The mark is a filled square (the computer) joined by a short rule to an
// outlined one (the phone) — drawn for the app's original name, Tether, and
// kept through the rename because it still says the true thing: two machines,
// one line between them, nothing else in the picture. Flat, square, and
// in `accentGraphic` — the reference's tiny vivid marks, not a badge. Centred
// on purpose: the brand block is one of the two sanctioned centrings
// (docs/DESIGN.md §2.6).

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Micro, Txt } from '../ui';

/** The link mark: a filled square joined to an outlined one. */
export function LogoMark({ size = 20 }: { size?: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      <View style={{ width: size, height: size, backgroundColor: theme.colors.accentGraphic }} />
      <View style={{ width: size, height: theme.layout.ruleEmphasis, backgroundColor: theme.colors.accentGraphic }} />
      <View
        style={{
          width: size,
          height: size,
          borderWidth: theme.layout.ruleEmphasis,
          borderColor: theme.colors.accentGraphic,
        }}
      />
    </View>
  );
}

/** Minimal logo plus name, centered. */
export function Brand() {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: theme.space.md, paddingBottom: theme.space.lg }}>
      <LogoMark size={16} />
      <Txt
        variant="display"
        style={{
          fontSize: 36,
          lineHeight: 40,
          textTransform: 'none',
          letterSpacing: -1,
        }}
      >
        Belay
      </Txt>
    </View>
  );
}
