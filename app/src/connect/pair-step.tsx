// Step two: trade the 6-digit code for a token.
//
// The reachable computer reads as a ledger — name, address, capability —
// closed by a rule, and the code entry sits under its own micro-label. The
// accent belongs to "Pair", the step's one primary action.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Badge, Banner, Button, Caption, Dot, Label, Row, Rule, Txt } from '../ui';
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
    <Banner
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
    <View testID="pair-step">
      <Row justify="space-between" align="flex-start" gap="sm">
        <View style={{ flex: 1, gap: theme.space.xxs }}>
          <Row gap="xs">
            <Dot status="good" pulse label="Host reachable" />
            <Txt variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
              {host.name}
            </Txt>
          </Row>
          <Txt variant="monoSmall" tone="faint" numberOfLines={1}>
            {prettyHost(host.url)}
          </Txt>
        </View>
        <Badge label={host.native ? 'Screen + input' : 'Terminal only'} status={host.native ? 'good' : 'warn'} />
      </Row>
      <Rule bleed={theme.layout.margin} style={{ marginTop: theme.space.sm }} />

      <View style={{ marginTop: theme.space.lg }}>
        <Label>Pairing code</Label>
        <Caption style={{ marginBottom: theme.space.sm }}>
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

        <Caption style={{ marginTop: theme.space.sm }}>
          Codes are single-use and expire after five minutes. The host keeps a fresh one on screen.
        </Caption>

        {host.paired && !codeUnlikely ? (
          // Redundant under the dead-end notice, which has already said —
          // more precisely — what being paired means for this screen.
          <Caption style={{ marginTop: theme.space.xxs }}>
            This computer already has another device paired — adding this one will not remove it.
          </Caption>
        ) : null}
      </View>

      <CapabilityNote native={host.native} />

      {error ? (
        <Banner testID="error" title={error.title} message={error.message} status="bad" style={{ marginTop: theme.space.md }} />
      ) : null}

      <Button
        label="Pair"
        variant={primary ? 'primary' : 'secondary'}
        onPress={onPair}
        loading={busy}
        disabled={busy}
        testID="pair-btn"
        fullWidth
        accessibilityHint={complete ? undefined : `Enter all ${CODE_LENGTH} digits first`}
        style={{ marginTop: theme.space.md }}
      />
      <Button
        label="Use a different computer"
        variant="ghost"
        onPress={onBack}
        testID="back-btn"
        fullWidth
        style={{ marginTop: theme.space.sm }}
      />
    </View>
  );
}
