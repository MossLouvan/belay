// Step one: point the app at the computer.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Badge, Banner, Button, Caption, Card, Column, Divider, IconButton, Input, Label, ListItem, Txt } from '../ui';
import { Diagnosis } from './diagnose';
import { HostResolution, isTailscaleAddress, prettyHost } from './host-input';

export interface HostStepProps {
  value: string;
  onChangeText: (next: string) => void;
  resolution: HostResolution;
  /** Suppresses inline validation until the user has actually typed something. */
  showResolution: boolean;
  busy: boolean;
  onSubmit: () => void;
  error: Diagnosis | null;
  recent: readonly string[];
  onPickRecent: (url: string) => void;
  onForgetRecent: (url: string) => void;
}

/** "Will connect to http://…" preview, or the reason we cannot build one. */
function ResolutionPreview({ resolution }: { resolution: HostResolution }) {
  const theme = useTheme();
  if (!resolution.ok) {
    return (
      <Txt variant="caption" tone="bad" style={{ marginTop: theme.space.xs }}>
        {resolution.reason}
      </Txt>
    );
  }
  return (
    <View style={{ marginTop: theme.space.xs, gap: theme.space.xs }}>
      <Txt variant="monoSmall" tone="dim">
        {`→ ${resolution.url}`}
      </Txt>
      {isTailscaleAddress(resolution.url) ? <Badge label="Tailscale · works anywhere" status="accent" /> : null}
      {resolution.hint ? (
        <Txt variant="caption" tone="warn" testID="host-hint">
          {resolution.hint}
        </Txt>
      ) : null}
    </View>
  );
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
    <View style={{ marginTop: theme.space.md }}>
      <Divider style={{ marginBottom: theme.space.sm }} />
      <Label>Recent</Label>
      {recent.map((url) => (
        <ListItem
          key={url}
          title={prettyHost(url)}
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
      ))}
    </View>
  );
}

export function HostStep({
  value,
  onChangeText,
  resolution,
  showResolution,
  busy,
  onSubmit,
  error,
  recent,
  onPickRecent,
  onForgetRecent,
}: HostStepProps) {
  const theme = useTheme();

  return (
    <Card testID="host-step">
      <Txt variant="subheading" heading style={{ marginBottom: theme.space.sm }}>
        Connect to your computer
      </Txt>

      <Input
        testID="host-input"
        label="Address"
        value={value}
        onChangeText={onChangeText}
        placeholder="192.168.1.20"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={onSubmit}
        // Locked while a check is in flight, matching the code field in the next
        // step: editing an address whose result is already on its way only
        // invites a second, overlapping check.
        editable={!busy}
        accessibilityLabel="Computer address"
        accessibilityHint="The address printed by the host agent on your computer"
      />
      {showResolution ? <ResolutionPreview resolution={resolution} /> : (
        <Caption style={{ marginTop: theme.space.xs }}>Port 8787 is added for you if you leave it off.</Caption>
      )}

      {error ? (
        <Banner testID="error" title={error.title} message={error.message} status="bad" style={{ marginTop: theme.space.md }} />
      ) : null}

      <Button
        label="Continue"
        onPress={onSubmit}
        loading={busy}
        testID="check-host"
        fullWidth
        style={{ marginTop: theme.space.md }}
      />

      <RecentHosts recent={recent} onPick={onPickRecent} onForget={onForgetRecent} />

      <Column style={{ marginTop: theme.space.md }}>
        <Caption>Tether talks straight to your computer. Nothing routes through anyone else.</Caption>
      </Column>
    </Card>
  );
}
