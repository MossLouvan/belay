// Computers linked to the account but not paired on this phone (GET /devices
// minus the local store — account/merge-devices.ts). One row each: name,
// platform in mono, and a Pair button that dials the tunnel and opens the
// code screen (pair-over-tunnel.ts). The account proves which node to dial;
// the host's own /pair still issues the token.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { IconLink } from '@tabler/icons-react-native';
import { Button, ListItem, Section } from '../ui';
import { useTheme } from '../theme';
import { errorMessage } from '../connect/pair-flow';
import type { AccountDevice } from './api';
import { startPairingOverTunnel } from './pair-over-tunnel';
import { useAccount } from './store';

export interface LinkedSectionProps {
  readonly devices: readonly AccountDevice[];
}

const UNREACHABLE = 'Belay could not reach that computer through the tunnel yet. Check it is awake and online; a just-linked computer admits this phone within a minute.';

export function LinkedSection({ devices }: LinkedSectionProps) {
  const theme = useTheme();
  const { removeDevice } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);

  const onRemove = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await removeDevice(id);
    } catch (e: unknown) {
      setError({ title: 'Could not remove', message: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }, [removeDevice]);

  const onPair = useCallback(async (d: AccountDevice) => {
    setBusy(d.id);
    setError(null);
    try {
      if (!(await startPairingOverTunnel(d.nodeId))) setError({ title: `Could not reach ${d.name}`, message: UNREACHABLE });
    } finally {
      setBusy(null);
    }
  }, []);

  if (devices.length === 0) return null;
  return (
    <Section label="Linked to your account" testID="linked-section">
      <View>
        {devices.map((d) => (
          <ListItem
            key={d.id}
            testID={`linked-${d.id}`}
            title={d.name}
            subtitle={`${d.platform} · not paired on this phone yet`}
            leading={<IconLink size={20} strokeWidth={2} color={theme.colors.textDim} />}
            trailing={
              <View style={{ flexDirection: 'row', gap: theme.space.xs }}>
                <Button
                  label="Pair" size="sm" testID={`pair-${d.id}`}
                  accessibilityLabel={`Pair ${d.name} through the tunnel`}
                  loading={busy === d.id} disabled={busy !== null}
                  onPress={() => void onPair(d)}
                />
                <Button
                  label="Remove" size="sm" variant="ghost" testID={`unlink-${d.id}`}
                  accessibilityLabel={`Remove ${d.name} from your account`}
                  disabled={busy !== null}
                  onPress={() => void onRemove(d.id)}
                />
              </View>
            }
          />
        ))}
        {error ? <ListItem title={error.title} subtitle={error.message} destructive /> : null}
      </View>
    </Section>
  );
}
