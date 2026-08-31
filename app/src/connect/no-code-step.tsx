// Shown when the code screen would be a trap: the host is reachable and wants
// a code, but it is already paired — and a paired host never issues one.
//
// This state cost a real hour once: the app presented six code boxes for a
// code that could not exist, and the owner sat entering guesses. So this is
// the full error anatomy (docs/DESIGN.md §11.4) — the observed fact stated as
// observation, inference marked as inference, one accented way forward, and a
// proof-of-life stamp. The code entry stays available below it, demoted,
// because the phone's knowledge can go stale the moment someone resets
// pairing on the computer — but nothing here pretends a code exists now.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Button, Caption, Label, Micro, Mono, Rule, Txt, haptic } from '../ui';
import type { TailnetStanding } from './dead-end';
import { checkedAtLabel, reopenPairingCommand } from './dead-end';
import { openTailscale } from './tailscale-card';

export interface NoCodeStepProps {
  /** What the computer is called, for a message that names it. */
  readonly hostName: string;
  /** The host's platform, so the reset command matches its shell. */
  readonly platform?: string;
  /** Where the tailnet route stands — it decides which fix leads. */
  readonly standing: TailnetStanding;
  /** The raw tailnet failure, shown small so a stuck setup can be reported. */
  readonly detail?: string | null;
  /** When the dead end was observed, for the proof-of-life stamp. */
  readonly checkedAt: number;
  /** Re-run the whole host check from scratch. */
  readonly onRecheck: () => void;
  /** True while a re-check is in flight. */
  readonly busy?: boolean;
}

/** What was actually seen, per tailnet standing — observation before advice. */
function observed(hostName: string, standing: TailnetStanding): string {
  const base =
    `${hostName} answered, and reports a device is already paired with it. ` +
    'It only shows a pairing code while nothing is paired — so as far as this ' +
    'phone can tell, there is no code on its screen for you to type.';
  if (standing === 'unreachable') {
    return (
      `${base} Its Tailscale address did not answer from this phone either, ` +
      'which usually means Tailscale is off or signed out here.'
    );
  }
  if (standing === 'unrecognised') {
    return (
      `${base} This phone did reach it over its Tailscale address, but the ` +
      'computer still asked for a code — it did not recognise this phone as ' +
      'yours.'
    );
  }
  return base;
}

/**
 * Whether the Tailscale app is the accented way forward.
 *
 * Only when turning it on could actually change the answer: the tailnet
 * address exists and this phone has not reached it. When the phone already
 * reached it and was refused, or the host has no tailnet address, sending
 * someone to the Tailscale app would be the old mistake — a confident fix for
 * a thing that is not broken.
 */
const tailscaleLeads = (standing: TailnetStanding): boolean =>
  standing === 'unreachable' || standing === 'untried';

/** The route that runs through the Tailscale app, when it can work. */
function TailscaleRoute({ onRecheck, busy }: { onRecheck: () => void; busy?: boolean }) {
  const theme = useTheme();
  const [opened, setOpened] = useState(false);

  const open = useCallback(() => {
    haptic('light');
    setOpened(true);
    void openTailscale();
  }, []);

  return (
    <View style={{ gap: theme.space.sm }}>
      <Txt variant="caption" tone="dim">
        On your own tailnet this computer pairs with no code at all. Turn Tailscale on, sign in
        with the same account the computer uses, and check again.
      </Txt>
      <Button label="Open Tailscale" onPress={open} fullWidth testID="open-tailscale" />
      {opened ? (
        <Button
          label="I turned it on — check again"
          variant="secondary"
          onPress={onRecheck}
          loading={busy}
          fullWidth
          testID="recheck-btn"
        />
      ) : null}
    </View>
  );
}

/**
 * The route that runs through the computer: reset pairing there.
 *
 * There is no gentler lever to point at — the host has no unpair command and
 * only issues codes while nothing is paired — so this shows the honest reset,
 * cost included. The accent lands on "Check again" only when Tailscale cannot
 * lead, keeping one solid accent per screen (§3.3).
 */
function ComputerRoute({
  hostName,
  platform,
  accented,
  onRecheck,
  busy,
}: {
  hostName: string;
  platform?: string;
  accented: boolean;
  onRecheck: () => void;
  busy?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.sm }}>
      <Label style={{ marginBottom: 0 }}>On the computer</Label>
      <Txt variant="caption" tone="dim">
        To get a fresh code, reset pairing on {hostName}: stop the host agent (Ctrl+C in its
        terminal), then run
      </Txt>
      <Mono>{reopenPairingCommand(platform)}</Mono>
      <Caption>
        It will print a new code and QR. Every device that was paired will need to pair again.
      </Caption>
      {accented ? (
        <Button
          label="Check again"
          onPress={onRecheck}
          loading={busy}
          fullWidth
          testID="recheck-btn"
        />
      ) : null}
    </View>
  );
}

export function NoCodeStep({
  hostName,
  platform,
  standing,
  detail,
  checkedAt,
  onRecheck,
  busy,
}: NoCodeStepProps) {
  const theme = useTheme();
  const viaTailscale = tailscaleLeads(standing);

  return (
    <View testID="no-code-step" style={{ gap: theme.space.md }}>
      <View style={{ gap: theme.space.sm }}>
        <Txt variant="label" tone="warn">No pairing code to enter</Txt>
        <Txt variant="caption" tone="dim">{observed(hostName, standing)}</Txt>
      </View>

      {viaTailscale ? <TailscaleRoute onRecheck={onRecheck} busy={busy} /> : null}

      <ComputerRoute
        hostName={hostName}
        platform={platform}
        accented={!viaTailscale}
        onRecheck={onRecheck}
        busy={busy}
      />

      {detail ? <Micro>{`Tailnet address said: ${detail}`}</Micro> : null}
      <Micro>{`Last checked ${checkedAtLabel(checkedAt)}`}</Micro>
      <Rule bleed={theme.layout.margin} />
    </View>
  );
}
