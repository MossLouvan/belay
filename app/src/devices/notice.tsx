// StatusNotice — the toned-down advisory for the devices and connect screens.
//
// The old Banner painted a saturated status fill behind the whole message,
// which made "your Mac is asleep" read like a fire. The reference (Next
// Terminal) keeps colour to small marks on navy, so this is a plain bordered
// Card with a 2pt status-coloured left edge as the only colour: the prose is
// normal text, the severity is the edge (docs sweep rule 3).

import React from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import type { Palette } from '../theme';
import { Card, Label, TrackLabel, Txt } from '../ui';
import type { Status } from '../ui';

const edgeColor = (status: Status, c: Palette): string => {
  const map: Record<Status, string> = {
    neutral: c.textFaint,
    good: c.good,
    warn: c.warn,
    bad: c.bad,
    accent: c.accent,
  };
  return map[status];
};

export interface StatusNoticeProps {
  message: string;
  title?: string;
  status?: Status;
  action?: { label: string; onPress: () => void };
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** Subtle bordered notice: navy card, 2pt status edge, calm prose. */
export function StatusNotice({
  message,
  title,
  status = 'neutral',
  action,
  testID,
  style,
}: StatusNoticeProps) {
  const theme = useTheme();
  const edge = edgeColor(status, theme.colors);

  return (
    <Card flush testID={testID} style={[{ overflow: 'hidden' }, style]}>
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={{
          borderLeftWidth: theme.layout.ruleEmphasis,
          borderLeftColor: edge,
          padding: theme.space.md,
          paddingLeft: theme.space.md - theme.layout.ruleEmphasis,
          gap: theme.space.xs,
        }}
      >
        {title ? <Label style={{ marginBottom: 0 }}>{title}</Label> : null}
        <Txt variant="body" tone="dim">{message}</Txt>
        {action ? (
          <TrackLabel
            label={action.label}
            onPress={action.onPress}
            style={{ alignSelf: 'flex-start', marginTop: theme.space.xxs }}
          />
        ) : null}
      </View>
    </Card>
  );
}
