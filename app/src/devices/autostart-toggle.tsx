// "Start Belay when this computer logs in" — the host's LaunchAgent / scheduled
// task, switched from the phone. Only meaningful for the connected computer:
// the host is the one that installs it, so there is nothing to show for a
// computer this phone is not talking to.

import React, { useCallback, useEffect, useState } from 'react';
import { Switch, View } from 'react-native';

import { api } from '../api';
import type { AutostartStatus } from '../api';
import { useTheme } from '../theme';
import { Caption, ListItem } from '../ui';

export const AUTOSTART_TITLE = 'Start Belay when this computer logs in';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface AutostartControl {
  readonly status: AutostartStatus | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly setEnabled: (on: boolean) => Promise<void>;
}

/** Reads the host's autostart state on mount; `setEnabled` flips it. */
export function useAutostart(): AutostartControl {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.autostartStatus()
      .then((s) => { if (live) setStatus(s); })
      // An older host has no /autostart; the row simply stays hidden.
      .catch((e: unknown) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, []);

  const setEnabled = useCallback(async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const reply = on ? await api.autostartEnable() : await api.autostartDisable();
      setStatus({ supported: true, installed: reply.installed });
      if (reply.restarting) {
        setError('Belay on that computer was started by autostart, so it is stopping now. Start it again by hand with npm start.');
      }
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, setEnabled };
}

/** The settings row. Renders nothing until the host has answered, or if it cannot autostart. */
export function AutostartRow() {
  const theme = useTheme();
  const { status, busy, error, setEnabled } = useAutostart();
  if (!status?.supported) return null;
  return (
    <View style={{ gap: theme.space.xs }}>
      <ListItem
        title={AUTOSTART_TITLE}
        subtitle={busy ? 'Working…' : status.installed ? 'On' : 'Off'}
        testID="autostart-row"
        trailing={
          <Switch
            value={status.installed}
            disabled={busy}
            onValueChange={(on) => { void setEnabled(on); }}
            trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
            accessibilityLabel={AUTOSTART_TITLE}
          />
        }
      />
      {error ? <Caption>{error}</Caption> : null}
    </View>
  );
}
