// Step two: trade the 6-digit code for a token — redesigned with premium
// glass aesthetic.
//
// Premium changes:
// - Glass panels for host info card
// - Better visual hierarchy and spacing
// - Cleaner presentation of capabilities

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Badge, Button, Caption, GlassPanel, StatusBadge, Label, Row, Txt } from '../ui';
import { StatusNotice } from '../devices/notice';
import { CodeInput } from './code-input';
import type { Diagnosis } from './diagnose';
import { prettyHost } from './host-input';

export const CODE_LENGTH = 6;

export interface HostSummary {
  readonly url: string;
  readonly name: string;
  /** `false` means the capture/input helper is not built on the host. */
  readonly native: boolean;
  readonly paired: boolean;
}

export interface PairStepProps {
  host: HostSummary;
  code: string;
  onChangeCode: (next: string) => void;
  onPair: () => void;
  onBack: () => void;
  busy: boolean;
  error: Diagnosis | null;
  /**
   * Whether "Pair" is the screen's one accent action. False while the
   * Tailscale fix above it holds the accent — one solid accent button per
   * screen (docs/DESIGN.md §3.3), and in that state the code is the fallback.
   */
  primary?: boolean;
  /**
   * True when the dead-end notice above has said no code exists right now.
   * The entry stays usable — the phone's knowledge goes stale the moment
   * someone resets pairing on the computer — but its captions must not claim
   * a code is on the host's screen, because as observed it is not.
   */
  codeUnlikely?: boolean;
}

/** Which capabilities this host actually offers, stated before pairing. */
function CapabilityNote({ native }: { native: boolean }) {
  const theme = useTheme();
  if (native) return null;
  return (
    <StatusNotice
      testID="native-warning"
      status="warn"
      title="Screen control is unavailable on this computer"
      message="The host agent's capture and input helper is not built, so the Screen tab will stay blank. Terminal, Files and System all work. Run the host's build:native step to enable it."
      style={{ marginTop: theme.space.md }}
    />
  );
}

export function PairStep({
  host, code, onChangeCode, onPair, onBack, busy, error, primary = true, codeUnlikely = false,
}: PairStepProps) {
  const theme = useTheme();
  const complete = code.length === CODE_LENGTH;

  return (
    <View testID="pair-step" style={{ gap: theme.space.xl }}>
      {/* Minimal host info — no panel, clean typography */}
      <View style={{ gap: theme.space.sm }}>
        <Row gap="xs" align="center">
          <StatusBadge label="Reachable" variant="default" />
          <Txt variant="subheading" numberOfLines={1} style={{ flex: 1 }}>
            {host.name}
          </Txt>
        </Row>
        <Row justify="space-between" align="center">
          <Txt variant="monoSmall" tone="faint" numberOfLines={1} style={{ flex: 1 }}>
            {prettyHost(host.url)}
          </Txt>
          <Badge label={host.native ? 'Screen + input' : 'Terminal only'} status={host.native ? 'good' : 'warn'} />
        </Row>
      </View>

      {/* Code entry section */}
      <View style={{ gap: theme.space.sm }}>
        <Label>Pairing code</Label>
        <Caption>
          {codeUnlikely
            ? `For when ${host.name} is actually showing one — right after a pairing reset, for instance.`
            : `It is shown in the Belay window on ${host.name}.`}
        </Caption>

        <CodeInput
          testID="code-input"
          value={code}
          onChange={onChangeCode}
          onSubmit={onPair}
          length={CODE_LENGTH}
          editable={!busy}
          invalid={Boolean(error)}
          autoFocus
        />

        <Caption>
          Codes are single-use and expire after five minutes.
        </Caption>
      </View>

      <CapabilityNote native={host.native} />

      {error ? (
        <StatusNotice testID="error" title={error.title} message={error.message} status="bad" />
      ) : null}

      {/* Clean button stack */}
      <View style={{ gap: theme.space.sm, marginTop: theme.space.md }}>
        <Button
          label="Pair"
          variant={primary ? 'primary' : 'secondary'}
          onPress={onPair}
          loading={busy}
          disabled={busy}
          testID="pair-btn"
          fullWidth
          size="lg"
          accessibilityHint={complete ? undefined : `Enter all ${CODE_LENGTH} digits first`}
        />
        <Button
          label="Use a different computer"
          variant="ghost"
          onPress={onBack}
          testID="back-btn"
          fullWidth
        />
      </View>
    </View>
  );
}
