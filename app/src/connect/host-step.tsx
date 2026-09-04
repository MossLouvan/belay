// Step one: point the app at the computer — redesigned with premium glass
// aesthetic inspired by Grok Bot UI.
//
// Premium changes:
// - Glass panels instead of cards for softer, cleaner feel
// - More generous spacing and negative space
// - Refined borders and subtle backgrounds
// - Cleaner button layout with primary/secondary hierarchy

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Badge, Button, Caption, GlassPanel, IconButton, Input, Label, ListItem, Row, Rule, Txt } from '../ui';
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
    <View testID="host-step" style={{ gap: theme.space.xl }}>
      {/* Minimal input — no panel wrapper, clean and direct */}
      <View style={{ gap: theme.space.sm }}>
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
          editable={!busy}
          accessibilityLabel="Computer address"
          accessibilityHint="The address printed by the host agent on your computer"
        />
        {showResolution ? <ResolutionPreview resolution={resolution} /> : (
          <Caption style={{ marginTop: theme.space.xs }}>Port 8787 is added for you if you leave it off.</Caption>
        )}
      </View>

      {error ? (
        <StatusNotice testID="error" title={error.title} message={error.message} status="bad" />
      ) : null}

      {/* Simplified button layout */}
      <View style={{ gap: theme.space.sm }}>
        <Button
          label="Connect"
          onPress={onSubmit}
          loading={busy}
          testID="check-host"
          fullWidth
          size="lg"
        />
        <Button
          label="Scan QR code"
          variant="secondary"
          onPress={onScan}
          testID="scan-btn"
          fullWidth
          size="lg"
          accessibilityHint="Scans the QR code the host agent prints"
        />
      </View>

      <RecentHosts recent={recent} onPick={onPickRecent} onForget={onForgetRecent} />
    </View>
  );
}
