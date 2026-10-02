// The lockup for the connect and sign-in screens: the beluga mark over the
// wordmark, both in the accent. Vector, so it recolours with the theme.
//
// Brand fades in with a short upward settle (useEntrance). Rope/carabiner
// motion lives in rope-splash / rope-pull — not a scribble of line segments here.

import React from 'react';
import { Animated } from 'react-native';
import { useTheme } from '../theme';
import { BelugaAvatar, Txt, useEntrance } from '../ui';
import { useLook } from '../design/use-look';

/** Beluga mark plus name, centered. Fades in with 8pt upward settle on mount. */
export function Brand() {
  const theme = useTheme();
  const entrance = useEntrance();
  // Harbour sets the lockup in its slate-navy ink, as gobelay.com does.
  const ink = useLook().name === 'harbour' ? theme.colors.text : theme.colors.accentGraphic;
  return (
    <Animated.View style={[{ alignItems: 'center', gap: theme.space.md, paddingBottom: theme.space.lg }, entrance]}>
      <BelugaAvatar size={40} color={ink} />
      <Txt
        variant="display"
        style={{
          fontSize: 36,
          lineHeight: 40,
          textTransform: 'none',
          letterSpacing: -1,
          color: ink,
        }}
      >
        Belay
      </Txt>
    </Animated.View>
  );
}
