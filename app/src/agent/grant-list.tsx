// The session's standing permissions, always one tap from view: a permission
// you cannot see or withdraw is a trapdoor, so every grant shows the exact
// sentence that was on the card when it was made, with revoke beside it.
// Collapsed to a single tracked line when closed — trust granted is trust
// visible, but it must not crowd the feed to stay that way.

import React, { useState } from 'react';
import { View } from 'react-native';
import type { ApprovalGrant } from '../api';
import { useTheme } from '../theme';
import { Row, TrackLabel, Txt } from '../ui';

export function GrantList({ grants, onRevoke }: {
  readonly grants: readonly ApprovalGrant[];
  readonly onRevoke: (grantId: string) => void;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  if (grants.length === 0) return null;

  return (
    <View style={{ gap: theme.space.xs }}>
      <TrackLabel
        testID="agent-grants-toggle"
        label={`Allowed without asking (${grants.length}) ${open ? '▴' : '▾'}`}
        accessibilityLabel="Standing permissions"
        accessibilityHint={open ? 'Hides the standing permissions' : 'Shows what runs without asking, with revoke'}
        active={open}
        onPress={() => setOpen((v) => !v)}
        hitSlop={theme.layout.hitSlop}
        style={{ alignSelf: 'flex-start' }}
      />
      {open ? grants.map((g) => (
        <Row key={g.id} justify="space-between" gap="sm">
          <Txt variant="caption" tone="dim" style={{ flexShrink: 1 }}>{g.label}</Txt>
          <TrackLabel
            testID={`agent-grant-revoke-${g.id}`}
            label="Revoke"
            labelColor={theme.colors.bad}
            trackColor={theme.colors.bad}
            accessibilityLabel={`Revoke: ${g.label}`}
            onPress={() => onRevoke(g.id)}
            hitSlop={theme.layout.hitSlop}
          />
        </Row>
      )) : null}
    </View>
  );
}
