// "● Connected" — the dot-and-a-word the concept mockups put under the host
// name, on both the computers list and the desktop.
//
// It is a thin view over `describeSurface`, so the wording and precedence stay
// the app's single source of truth (src/ui/connection-view.ts): a surface may
// not claim Connected while the link is down. What this adds is only the
// drawing — the small filled disc for a steady state, a hollow ring while one
// is forming, which is how "still working on it" is said without a blink.

import React from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { Row, Txt } from '../ui';
import { describeSurface } from '../ui/connection-view';
import type { ConnectionPhase, SurfacePhase } from '../ui/connection-view';

export interface StatusLineProps {
  readonly phase: ConnectionPhase;
  readonly surface?: SurfacePhase;
  readonly detail?: string;
  readonly paired?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export function StatusLine({ phase, surface, detail, paired, style, testID }: StatusLineProps) {
  const theme = useTheme();
  const view = describeSurface(phase, surface, { paired, detail });
  const tint = view.status === 'good' ? theme.colors.good
    : view.status === 'bad' ? theme.colors.bad
      : view.status === 'warn' ? theme.colors.warn : theme.colors.accentGraphic;

  return (
    <Row gap="xs" align="center" style={style} testID={testID}>
      <View
        accessibilityElementsHidden
        style={{
          width: 9,
          height: 9,
          borderRadius: 4.5,
          backgroundColor: view.ring ? 'transparent' : tint,
          borderWidth: view.ring ? 2 : 0,
          borderColor: tint,
        }}
      />
      <Txt variant="body" tone="dim" numberOfLines={1}>{view.word}</Txt>
      {view.detail ? <Txt variant="caption" tone="faint" numberOfLines={1}>{view.detail}</Txt> : null}
    </Row>
  );
}
