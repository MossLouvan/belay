// The "what am I looking at" half of the connect screen. Someone opening Tether
// for the first time has no idea what an address or a pairing code is, so this
// explains the whole setup before asking them to type anything.

import React, { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTheme } from '../theme';
import { Caption, Card, Column, Mono, Row, Txt } from '../ui';

interface StepProps {
  index: number;
  title: string;
  detail: string;
  code?: string;
}

function Step({ index, title, detail, code }: StepProps) {
  const theme = useTheme();
  return (
    <Row align="flex-start" gap="sm">
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          backgroundColor: theme.colors.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        }}
      >
        <Txt variant="caption" color={theme.colors.onAccentSoft} style={{ fontWeight: '800' }}>
          {index}
        </Txt>
      </View>
      <Column style={{ flex: 1 }} gap="xxs">
        <Txt variant="bodyStrong">{title}</Txt>
        <Txt variant="caption" tone="dim">
          {detail}
        </Txt>
        {code ? (
          <View
            style={{
              marginTop: theme.space.xxs,
              alignSelf: 'flex-start',
              backgroundColor: theme.colors.surfaceAlt,
              borderRadius: theme.radius.sm,
              borderWidth: theme.layout.hairline,
              borderColor: theme.colors.border,
              paddingHorizontal: theme.space.sm,
              paddingVertical: theme.space.xxs + 2,
            }}
          >
            <Mono>{code}</Mono>
          </View>
        ) : null}
      </Column>
    </Row>
  );
}

const STEPS: readonly Omit<StepProps, 'index'>[] = [
  {
    title: 'Start the host agent on your computer',
    detail: 'It is the small program that lets Tether in. Leave it running.',
    code: 'cd server && npm start',
  },
  {
    title: 'Read the address it prints',
    detail: 'Something like 192.168.1.20:8787. Type it in below.',
  },
  {
    title: 'Enter the 6-digit code it shows',
    detail: 'One time only. After that your phone remembers this computer.',
  },
];

/** Numbered setup checklist. */
export function SetupSteps() {
  return (
    <Card>
      <Txt variant="subheading" heading style={{ marginBottom: 12 }}>
        Before you connect
      </Txt>
      <Column gap="md">
        {STEPS.map((step, i) => (
          <Step key={step.title} index={i + 1} {...step} />
        ))}
      </Column>
    </Card>
  );
}

/** Collapsible explainer for reaching the PC from outside the house. */
export function AwayFromHomeNote() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  return (
    <Card padding="sm">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={open ? 'Collapses the section' : 'Expands the section'}
        onPress={toggle}
        testID="tailscale-note"
        style={{ minHeight: theme.layout.minTouch, justifyContent: 'center', paddingHorizontal: theme.space.xs }}
      >
        <Row justify="space-between">
          <Txt variant="bodyStrong">Connecting from outside your home</Txt>
          <Txt variant="bodyStrong" tone="faint">
            {open ? '−' : '+'}
          </Txt>
        </Row>
      </Pressable>
      {open ? (
        <Column gap="xs" style={{ paddingHorizontal: theme.space.xs, paddingBottom: theme.space.xs, paddingTop: theme.space.xs }}>
          <Txt variant="caption" tone="dim">
            On the same Wi-Fi, the address your computer prints works as-is. On cellular it will not — your
            home network is not reachable from the outside.
          </Txt>
          <Txt variant="caption" tone="dim">
            Install Tailscale on both devices and use the computer's Tailscale address instead. It starts with
            100. and works from anywhere, encrypted end to end, with no port forwarding.
          </Txt>
          <Caption>Never expose the host agent directly to the internet.</Caption>
        </Column>
      ) : null}
    </Card>
  );
}
