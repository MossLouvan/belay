// A slim, always-honest connection status row: a status Dot beside the one
// canonical label for the current link state, with room for a trailing action
// (the way out to My Computers). One source of truth so no two tabs word the
// same state differently (docs/FRONTEND-REVAMP.md §4.1).

import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { Dot } from './feedback';
import { Label } from './text';
import { Row } from './layout';
import { describeConnection } from './connection-view';
import type { ConnectionPhase } from './connection-view';

export interface ConnectionStatusProps {
  readonly phase: ConnectionPhase;
  readonly machine?: string;
  /** A trailing affordance on the same line, e.g. the switch-computer link. */
  readonly trailing?: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export function ConnectionStatus({ phase, machine, trailing, style, testID }: ConnectionStatusProps) {
  const theme = useTheme();
  const view = describeConnection(phase, machine);
  return (
    <Row justify="space-between" gap="sm" style={style} testID={testID}>
      <Row gap="xs" style={{ flexShrink: 1 }}>
        {/* The visible Label already speaks the state; a label on the Dot would
            make a screen reader announce it twice. */}
        <Dot status={view.status} pulse={view.pulse} size={7} />
        <Label style={{ marginBottom: 0 }} numberOfLines={1}>{view.label}</Label>
      </Row>
      {trailing ?? null}
    </Row>
  );
}
