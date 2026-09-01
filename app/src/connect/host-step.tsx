// Step one: point the app at the computer.
//
// Ledger anatomy rather than a card: the section label marks the step, the
// address field is the page's one `surface` fill, and the recent computers
// are hairline-separated rows under their own micro-label.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Badge, Banner, Button, Caption, IconButton, Input, Label, ListItem, Rule, Txt } from '../ui';
import type { Diagnosis } from './diagnose';
import { isTailscaleAddress, prettyHost } from './host-input';
import type { HostResolution } from './host-input';

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
    <View style={{ marginTop: theme.space.lg }}>
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
    <View testID="host-step">
      <Input
        testID="host-input"
        label="Computer address"
        value={value}
        onChangeText={onChangeText}
        placeholder="192.168.1.20"
        mono
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
        label="Connect"
        onPress={onSubmit}
        loading={busy}
        testID="check-host"
        fullWidth
        style={{ marginTop: theme.space.md }}
      />

      <RecentHosts recent={recent} onPick={onPickRecent} onForget={onForgetRecent} />

      <Caption style={{ marginTop: theme.space.md }}>
        Belay talks straight to your computer. Nothing routes through anyone else.
      </Caption>
    </View>
  );
}
