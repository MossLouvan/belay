// The "what am I looking at" half of the connect screen. Someone opening Belay
// for the first time has no idea what an address or a pairing code is, so this
// explains the whole setup before asking them to type anything.
//
// Ledger anatomy: each step is a mono ordinal in the margin column and prose
// beside it — no numbered circles, no boxed commands. The command someone has
// to run is machine voice, so it is plain mono on the page.

import React, { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTheme } from '../theme';
import { Caption, Label, Mono, Row, Rule, Section, Txt } from '../ui';

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
      <Label style={{ marginBottom: 0, marginTop: 3, width: theme.space.lg }}>{`0${index}`}</Label>
      <View style={{ flex: 1, gap: theme.space.xxs }}>
        <Txt variant="bodyStrong">{title}</Txt>
        <Txt variant="caption" tone="dim">
          {detail}
        </Txt>
        {code ? <Mono style={{ marginTop: theme.space.xxs }}>{code}</Mono> : null}
      </View>
    </Row>
  );
}

const STEPS: readonly Omit<StepProps, 'index'>[] = [
  {
    title: 'Start the host agent on your computer',
    detail: 'It is the small program that lets Belay in. Leave it running.',
    code: 'cd server && npm start',
  },
  {
    // The Screen tab is black until this is granted, and macOS never prompts
    // for it on a background agent — so a first-time Mac user has no way to know
    // it is even needed. Windows and Linux need nothing here, hence "On a Mac".
    title: 'On a Mac, allow Screen Recording',
    detail:
      'System Settings › Privacy & Security › Screen Recording — switch on the app running the host agent (Terminal, or your code editor), then start it again. Without it the Screen tab stays black; Agent, Terminal, Files and System still work.',
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
  const theme = useTheme();
  return (
    <Section label="Before you connect" bleed={theme.layout.margin}>
      <View style={{ gap: theme.space.md }}>
        {STEPS.map((step, i) => (
          <Step key={step.title} index={i + 1} {...step} />
        ))}
      </View>
    </Section>
  );
}

/** Collapsible explainer for reaching the PC from outside the house. */
export function AwayFromHomeNote() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={open ? 'Collapses the section' : 'Expands the section'}
        onPress={toggle}
        testID="tailscale-note"
        style={({ pressed }) => ({
          minHeight: theme.layout.minTouch,
          justifyContent: 'center',
          opacity: pressed ? theme.motion.pressOpacity : 1,
        })}
      >
        <Row justify="space-between">
          <Label style={{ marginBottom: 0 }}>Away from home</Label>
          <Label style={{ marginBottom: 0 }}>{open ? '−' : '+'}</Label>
        </Row>
      </Pressable>
      {open ? (
        <View style={{ gap: theme.space.xs, paddingBottom: theme.space.sm }}>
          <Txt variant="caption" tone="dim">
            On the same Wi-Fi, the address your computer prints works as-is. On cellular it will not — your
            home network is not reachable from the outside.
          </Txt>
          <Txt variant="caption" tone="dim">
            Install Tailscale on both devices and use the computer's Tailscale address instead. It starts with
            100. and works from anywhere, encrypted end to end, with no port forwarding.
          </Txt>
          <Caption>Never expose the host agent directly to the internet.</Caption>
        </View>
      ) : null}
      <Rule bleed={theme.layout.margin} />
    </View>
  );
}
