// First-run hint: one quiet line pointing at the control bar, shown until
// it is dismissed or proved unnecessary (the user opens Keyboard or Tools).
// Whether it shows is a pure decision (screen-chrome.ts hintVisible).

import React from 'react';
import { Caption, IconButton, Row, Txt } from '../ui';

export interface ControlHintProps {
  readonly onDismiss: () => void;
}

export function ControlHint({ onDismiss }: ControlHintProps) {
  return (
    <Row testID="control-bar-hint" justify="space-between" align="center" gap="sm">
      <Caption style={{ flexShrink: 1 }}>
        New here? Keyboard and all your tools live down here.
      </Caption>
      <IconButton
        testID="dismiss-hint"
        accessibilityLabel="Dismiss this hint"
        variant="plain"
        onPress={onDismiss}
      >
        <Txt variant="label" tone="dim">×</Txt>
      </IconButton>
    </Row>
  );
}
