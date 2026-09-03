// Step one: point the app at the computer.
//
// Sweep anatomy (Next Terminal): the address lives in one clean bordered
// card, a solid-blue CONNECT beside a quiet SCAN below it, and failures come
// back as a calm bordered notice — not a saturated fill. The recent computers
// stay hairline-separated rows under their own micro-label.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Badge, Button, Caption, Card, IconButton, Input, Label, ListItem, Row, Rule, Txt } from '../ui';
import { StatusNotice } from '../devices/notice';
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
  /** Opens the QR scanner — the second way in, beside Connect. */
  onScan: () => void;
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
  onScan,
  error,
  recent,
  onPickRecent,
  onForgetRecent,
}: HostStepProps) {
  const theme = useTheme();

  return (
    <View testID="host-step">
      <Card>
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
      </Card>

      {error ? (
        <StatusNotice testID="error" title={error.title} message={error.message} status="bad" style={{ marginTop: theme.space.md }} />
      ) : null}

      <Row gap="sm" style={{ marginTop: theme.space.md }}>
        <View style={{ flex: 1 }}>
          <Button
            label="Connect"
            onPress={onSubmit}
            loading={busy}
            testID="check-host"
            fullWidth
          />
        </View>
        <Button
          label="Scan"
          variant="secondary"
          onPress={onScan}
          testID="scan-btn"
          accessibilityHint="Scans the QR code the host agent prints"
        />
      </Row>

      <RecentHosts recent={recent} onPick={onPickRecent} onForget={onForgetRecent} />

      <Caption style={{ marginTop: theme.space.md }}>
        Belay talks straight to your computer. Nothing routes through anyone else.
      </Caption>
    </View>
  );
}
