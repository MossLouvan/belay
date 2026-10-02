// Computers linked to the account but not paired on this phone (GET /devices
// minus the local store — account/merge-devices.ts). One row each: name,
// platform in mono, and the honest state — reachable once the tunnel ships.

import React from 'react';
import { View } from 'react-native';
import { IconLink } from '@tabler/icons-react-native';
import { ListItem, Section } from '../ui';
import { useTheme } from '../theme';
import type { AccountDevice } from './api';

export interface LinkedSectionProps {
  readonly devices: readonly AccountDevice[];
}

export function LinkedSection({ devices }: LinkedSectionProps) {
  const theme = useTheme();
  if (devices.length === 0) return null;
  return (
    <Section label="Linked to your account" testID="linked-section">
      <View>
        {devices.map((d) => (
          <ListItem
            key={d.id}
            testID={`linked-${d.id}`}
            title={d.name}
            subtitle={`${d.platform} · pairs over the tunnel when it is ready`}
            leading={<IconLink size={20} strokeWidth={2} color={theme.colors.textDim} />}
          />
        ))}
      </View>
    </Section>
  );
}
