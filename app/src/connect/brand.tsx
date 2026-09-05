// Wordmark and logo for the connect screen. Drawn from Views so there is no
// image to decode and it recolours with the theme.
//
// Brand fades in with a short upward settle (useEntrance). Rope/carabiner
// motion lives in rope-splash / rope-pull — not a scribble of line segments here.

import React from 'react';
import { Animated, View } from 'react-native';
import { useTheme } from '../theme';
import { Txt, useEntrance } from '../ui';

/** The link mark: a filled square joined to an outlined one. */
export function LogoMark({ size = 20 }: { size?: number }) {
  const theme = useTheme();
  const accentColor = theme.colors.accentGraphic;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      <View style={{ width: size, height: size, backgroundColor: accentColor }} />
      <View style={{ width: size, height: theme.layout.ruleEmphasis, backgroundColor: accentColor }} />
      <View
        style={{
          width: size,
          height: size,
          borderWidth: theme.layout.ruleEmphasis,
          borderColor: accentColor,
        }}
      />
    </View>
  );
}

/** Minimal logo plus name, centered. Fades in with 8pt upward settle on mount. */
export function Brand() {
  const theme = useTheme();
  const entrance = useEntrance();
  return (
    <Animated.View style={[{ alignItems: 'center', gap: theme.space.md, paddingBottom: theme.space.lg }, entrance]}>
      <LogoMark size={16} />
      <Txt
        variant="display"
        style={{
          fontSize: 36,
          lineHeight: 40,
          textTransform: 'none',
          letterSpacing: -1,
          color: theme.colors.accentGraphic,
        }}
      >
        Belay
      </Txt>
    </Animated.View>
  );
}
