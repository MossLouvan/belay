// Computers linked to the account but not paired on this phone (GET /devices
// minus the local store — account/merge-devices.ts). One row each: name,
// platform in mono, and the honest state — reachable once the tunnel ships.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { IconLink } from '@tabler/icons-react-native';
import { Button, ListItem, Section } from '../ui';
import { useTheme } from '../theme';
import { errorMessage } from '../connect/pair-flow';
import type { AccountDevice } from './api';
import { useAccount } from './store';

export interface LinkedSectionProps {
  readonly devices: readonly AccountDevice[];
}

export function LinkedSection({ devices }: LinkedSectionProps) {
  const theme = useTheme();
  const { removeDevice } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onRemove = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await removeDevice(id);
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [removeDevice]);

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
            trailing={
              <Button
                label="Remove" size="sm" variant="ghost" testID={`unlink-${d.id}`}
                accessibilityLabel={`Remove ${d.name} from your account`}
                loading={busy === d.id} disabled={busy !== null}
                onPress={() => void onRemove(d.id)}
              />
            }
          />
        ))}
        {error ? <ListItem title="Could not remove" subtitle={error} destructive /> : null}
      </View>
    </Section>
  );
}
