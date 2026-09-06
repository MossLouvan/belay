// Step one of the connect screen: point the app at the computer.
//
// The address entry itself is shared (address-entry.tsx) so the connect
// screen and the computer list's "add a computer" path are the same field;
// this step adds what only the connect screen has — the failure notice for
// the last attempt, and the remembered computers beneath.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { IconButton, Label, ListItem, Rule, Txt } from '../ui';
import { StatusNotice } from '../devices/notice';
import type { Diagnosis } from './diagnose';
import { AddressEntry } from './address-entry';
import type { DiscoveredShortcut } from './address-entry';
import { isTailscaleAddress, prettyHost } from './host-input';

export interface HostStepProps {
  value: string;
  onChangeText: (next: string) => void;
  busy: boolean;
  onSubmit: () => void;
  /** Opens the QR scanner — the quieter second way in. */
  onScan: () => void;
  /** Focus the field the moment the step shows. */
  autoFocus?: boolean;
  /** A computer already answering over the tailnet, offered above the field. */
  discovered?: DiscoveredShortcut | null;
  error: Diagnosis | null;
  recent: readonly string[];
  onPickRecent: (url: string) => void;
  onForgetRecent: (url: string) => void;
}

function RecentHosts({
  recent,
  onPick,
  onForget,
}: {
  recent: readonly string[];
  onPick: (url: string) => void;
  onForget: (url: string) => void;
}) {
  const theme = useTheme();
  if (recent.length === 0) return null;

  return (
    <View>
      <Label>Recent</Label>
      <Rule bleed={theme.layout.margin} />
      {recent.map((url) => (
        <View key={url}>
          <ListItem
            title={prettyHost(url)}
            mono
            subtitle={isTailscaleAddress(url) ? 'Tailscale' : 'Local network'}
            onPress={() => onPick(url)}
            testID={`recent-${prettyHost(url)}`}
            accessibilityHint="Uses this address"
            trailing={
              <IconButton
                accessibilityLabel={`Forget ${prettyHost(url)}`}
                onPress={() => onForget(url)}
                variant="plain"
                testID={`forget-${prettyHost(url)}`}
              >
                <Txt variant="bodyStrong" tone="faint">
                  ×
                </Txt>
              </IconButton>
            }
          />
          <Rule bleed={theme.layout.margin} />
        </View>
      ))}
    </View>
  );
}

export function HostStep({
  value,
  onChangeText,
  busy,
  onSubmit,
  onScan,
  autoFocus,
  discovered,
  error,
  recent,
  onPickRecent,
  onForgetRecent,
}: HostStepProps) {
  const theme = useTheme();

  return (
    <View testID="host-step" style={{ gap: theme.space.xl }}>
      <AddressEntry
        value={value}
        onChangeText={onChangeText}
        onSubmit={onSubmit}
        busy={busy}
        autoFocus={autoFocus}
        discovered={discovered}
        onScan={onScan}
      />

      {error ? (
        <StatusNotice testID="error" title={error.title} message={error.message} status="bad" />
      ) : null}

      <RecentHosts recent={recent} onPick={onPickRecent} onForget={onForgetRecent} />
    </View>
  );
}
