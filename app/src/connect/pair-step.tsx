// Step two: trade the 6-digit code for a token.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Badge, Banner, Button, Caption, Card, Column, Dot, Row, Txt } from '../ui';
import { CodeInput } from './code-input';
import { Diagnosis } from './diagnose';
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

export function PairStep({ host, code, onChangeCode, onPair, onBack, busy, error }: PairStepProps) {
  const theme = useTheme();
  const complete = code.length === CODE_LENGTH;

  return (
    <Card testID="pair-step">
      <Row justify="space-between" align="flex-start">
        <Column style={{ flex: 1 }} gap="xxs">
          <Row gap="xs">
            <Dot status="good" pulse label="Host reachable" />
            <Txt variant="subheading" numberOfLines={1}>
              {host.name}
            </Txt>
          </Row>
          <Txt variant="monoSmall" tone="faint" numberOfLines={1}>
            {prettyHost(host.url)}
          </Txt>
        </Column>
        <Badge label={host.native ? 'Screen + input' : 'Terminal only'} status={host.native ? 'good' : 'warn'} />
      </Row>

      <View style={{ height: theme.space.lg }} />

      <Txt variant="bodyStrong">Enter the pairing code</Txt>
      <Caption style={{ marginTop: theme.space.xxs, marginBottom: theme.space.sm }}>
        It is shown in the Tether window on {host.name}.
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

      {host.paired ? (
        <Caption style={{ marginTop: theme.space.xxs }}>
          This computer already has another device paired — adding this one will not remove it.
        </Caption>
      ) : null}

      <CapabilityNote native={host.native} />

      {error ? (
        <Banner testID="error" title={error.title} message={error.message} status="bad" style={{ marginTop: theme.space.md }} />
      ) : null}

      <Button
        label="Pair"
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
    </Card>
  );
}
