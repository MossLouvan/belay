// "Keep running with the lid closed" — the host's lid-closed mode, switched
// from the phone. Same shape as the autostart row: read on mount, flip on
// toggle, show the host's reason when it refuses (the macOS admin prompt was
// cancelled, or the platform cannot do it).

import React, { useCallback, useEffect, useState } from 'react';
import { Switch, View } from 'react-native';

import { api } from '../api';
import type { LidModeState, LidModeStatus } from '../api';
import { useTheme } from '../theme';
import { Caption, Card } from '../ui';
import { CardRow } from './card-row';

export const LID_TITLE = 'Keep running with the lid closed';

export const LID_STATE_LABEL: Readonly<Record<LidModeState, string>> = {
  off: 'Off',
  ready: 'Ready',
  awake: 'Keeping awake',
  'battery-low': 'Stopped — battery low',
};

const HELP =
  'While a phone is streaming, this computer stays awake with the lid shut and streams a virtual display at your size. ' +
  'It sleeps normally again after 30 minutes without a stream, or at 20% on battery.';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Polled with the rest of the System tab so the state line stays live. */
export function LidCard({ pollKey }: { pollKey: number }) {
  const theme = useTheme();
  const [status, setStatus] = useState<LidModeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.lidMode()
      .then((s) => { if (live) setStatus(s); })
      // An older host has no /lid-mode; the card simply stays hidden.
      .catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [pollKey]);

  const setEnabled = useCallback(async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.setLidMode(on));
    } catch (e: unknown) {
      setError(errorMessage(e));
      api.lidMode().then(setStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  }, []);

  if (!status?.supported) return null;
  return (
    <Card flush title="Lid closed" testID="lid-card">
      <CardRow label={LID_TITLE} testID="lid-switch-row">
        <Switch
          value={status.enabled}
          disabled={busy}
          onValueChange={(on) => { void setEnabled(on); }}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          accessibilityLabel={LID_TITLE}
          testID="lid-switch"
        />
      </CardRow>
      <CardRow label="State" value={busy ? 'Working…' : LID_STATE_LABEL[status.status]} divider={false} testID="lid-state" />
      <View style={{ paddingHorizontal: theme.space.md, paddingBottom: theme.space.md }}>
        <Caption>{error ?? HELP}</Caption>
      </View>
    </Card>
  );
}
