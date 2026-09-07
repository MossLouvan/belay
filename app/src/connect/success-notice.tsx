// The receipt after a successful pair, shown for SUCCESS_DWELL_MS before the
// desktop takes over.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Caption, Rule, Txt } from '../ui';

export interface SuccessNoticeProps {
  readonly name: string;
}

export function SuccessNotice({ name }: SuccessNoticeProps) {
  const theme = useTheme();
  return (
    <View testID="pair-success" style={{ gap: theme.space.sm }}>
      <Txt variant="label" tone="good">{'\u2713 Paired'}</Txt>
      <Txt variant="subheading">Paired with {name}</Txt>
      <Caption>You will not need the code again on this device.</Caption>
      <Rule bleed={theme.layout.margin} />
    </View>
  );
}
