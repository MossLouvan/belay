// A data row for a flush Card — the reference's table anatomy: label left in
// the uppercase mono voice, value (or custom trailing content) right in mono,
// hairline Divider underneath. Used by the host facts, paired devices and
// connection cards so every list on the System tab reads as one table style.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Divider, Label, Row, Txt } from '../ui';
import type { TextTone } from '../ui';

export interface CardRowProps {
  /** The key, set as a mono micro-label: "UPTIME", "OS". */
  label: string;
  /** The value, flush right in mono. */
  value?: string;
  valueTone?: TextTone;
  /** Custom trailing content when a plain mono string is not enough. */
  children?: React.ReactNode;
  /** Draws the hairline under the row. Off for a card's last row. */
  divider?: boolean;
  testID?: string;
}

/** Row height keeps a comfortable data-table rhythm without touch-target bulk. */
const MIN_HEIGHT = 44;

export function CardRow({ label, value, valueTone = 'default', children, divider = true, testID }: CardRowProps) {
  const theme = useTheme();
  return (
    <View testID={testID}>
      <Row
        justify="space-between"
        gap="sm"
        style={{ minHeight: MIN_HEIGHT, paddingHorizontal: theme.space.md }}
      >
        <Label style={{ marginBottom: 0 }}>{label}</Label>
        {children ??
          (value !== undefined ? (
            <Txt variant="mono" tone={valueTone} numberOfLines={1} style={{ textAlign: 'right', flexShrink: 1 }}>
              {value}
            </Txt>
          ) : null)}
      </Row>
      {divider ? <Divider /> : null}
    </View>
  );
}
