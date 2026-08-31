// Shown when a host is reachable but the tailnet is not.
//
// This is the only failure on the connect screen with a one-tap fix, so it
// gets the full error anatomy (docs/DESIGN.md §11.4) rather than a line of
// red text: the observed state, what it means, the one accent way forward,
// and the raw probe result as proof for a stuck setup. The computer is fine;
// Tailscale on this phone is not, and the button goes straight there.

import React, { useCallback, useState } from 'react';
import { Linking, View } from 'react-native';
import { useTheme } from '../theme';
import { TAILSCALE_APP_URL, TAILSCALE_STORE_URL } from './tailnet';
import { Button, Micro, Rule, Txt, haptic } from '../ui';

interface TailscaleStepProps {
  /** What the computer is called, for a message that names it. */
  readonly hostName: string;
  /** The underlying failure, shown small so a stuck setup can be reported. */
  readonly detail?: string | null;
  /** Re-run the check once Tailscale is on. */
  readonly onRetry: () => void;
  /** True while the retry is in flight. */
  readonly busy?: boolean;
}

/**
 * Open the Tailscale app, falling back to the App Store when it is not
 * installed.
 *
 * `canOpenURL` is the documented check, but on iOS it answers false for any
 * scheme not in `LSApplicationQueriesSchemes`, so a false there does not mean
 * the app is missing. Attempting the open and treating a throw as "absent" is
 * the reliable order.
 */
export async function openTailscale(): Promise<void> {
  try {
    await Linking.openURL(TAILSCALE_APP_URL);
  } catch {
    await Linking.openURL(TAILSCALE_STORE_URL).catch(() => undefined);
  }
}

export function TailscaleStep({ hostName, detail, onRetry, busy }: TailscaleStepProps) {
  const theme = useTheme();
  const [opened, setOpened] = useState(false);

  const open = useCallback(() => {
    haptic('light');
    setOpened(true);
    void openTailscale();
  }, []);

  return (
    <View style={{ gap: theme.space.sm }}>
      {/* Observation first, inference second. This card once said "Tailscale
          is off" for an iOS transport-security block and sent the owner to fix
          an app that was fine — the probe only shows the address not
          answering, so that is what the headline says. */}
      <Txt variant="label" tone="warn">No answer over Tailscale</Txt>
      <Txt variant="caption" tone="dim">
        {hostName} answered on its regular address, but its Tailscale address did not — even
        after several tries. That usually means Tailscale is off or signed out on this phone.
        With it on, Tether connects with no pairing code — at home or anywhere else.
      </Txt>

      <Button label="Open Tailscale" onPress={open} fullWidth />

      {opened ? (
        <Button
          label="I turned it on — connect"
          variant="secondary"
          onPress={onRetry}
          loading={busy}
          fullWidth
        />
      ) : null}

      <Txt variant="caption" tone="faint">
        Sign in with the same account your computer uses. Nothing routes through anyone else.
      </Txt>

      {detail ? <Micro>{`Tailnet address said: ${detail}`}</Micro> : null}
      <Rule bleed={theme.layout.margin} />
    </View>
  );
}
