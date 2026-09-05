// Desktop-first navigation: the live desktop IS the app.
//
// The five bottom tabs are gone. This group is now a stack anchored on the
// desktop (`screen`), and the four tools — Agent, Terminal, Files, System —
// present as slide-up panels over it: a native sheet on iOS (grab handle and
// swipe-down for free), a full-screen slide-up on Android. The desktop's own
// control bar (src/screen/dock.tsx) carries the way in: the TOOLS key opens
// the drawer in src/home/tool-drawer.tsx, which navigates here.
//
// What this layout still owns from the tab era, unchanged in behaviour:
//   - the connection guard (no live link → the devices list or pairing),
//   - mounting the agent attention store for the whole app,
//   - wiping that store when the active computer changes.
// The "needs you" band moved closer to the surfaces: the desktop lays it
// inline above its control bar, and every tool panel floats it over its own
// bottom edge (src/home/panel.tsx) — a native modal would otherwise cover a
// band mounted here.

import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useConnection } from '../../src/connection';
import { useTheme } from '../../src/theme';
import { useAgentAttention, resetAttention } from '../../src/agent/attention-store';

/** Whatever route arrives first (a deep link straight to a tool panel
 *  included), the desktop is always the screen underneath it. The anchor
 *  ensures tool panels open OVER the desktop even when arriving via deep link,
 *  but it assumes 'screen' will mount. The guard below (redirecting to /
 *  without a connection) ensures screen is never bypassed entirely. */
export const unstable_settings = { anchor: 'screen', initialRouteName: 'screen' };

const TOOL_ROUTES = ['agent', 'terminal', 'files', 'system'] as const;

export default function HomeLayout() {
  const { ready, connection, devices, phase } = useConnection();
  const theme = useTheme();
  // Mounting the attention store here keeps the session list current for the
  // whole app; it feeds the dock's Tools chip, the drawer's Agent row and the
  // "needs you" band.
  useAgentAttention();

  // The attention store is module-level and its sessions/openId/approvals are
  // scoped to one host. When the active computer changes, wipe them so a
  // quick-switch can't leave the old host's session open (a dead
  // `/ws/agent?session=<old-id>` against the new host) or POST its pending
  // approval to the wrong machine. Keyed on host, so a plain reconnect to the
  // same computer keeps the open session.
  const host = connection?.host ?? null;
  const prevHostRef = React.useRef<string | null>(host);
  React.useEffect(() => {
    if (prevHostRef.current !== host) {
      if (prevHostRef.current !== null) resetAttention();
      prevHostRef.current = host;
    }
  }, [host]);

  // Guard: never show the desktop without a live connection. Where to send the
  // user depends on why there isn't one — with no computers saved they need the
  // add flow, otherwise they need the list, which can say what went wrong.
  if (ready && !connection && phase !== 'connecting') {
    return <Redirect href={devices.length > 0 ? '/devices' : '/'} />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      <Stack.Screen name="screen" options={{ animation: 'fade' }} />
      {TOOL_ROUTES.map((name) => (
        <Stack.Screen
          key={name}
          name={name}
          options={{
            // iOS: a native sheet over the desktop, dismissed by the panel
            // bar's "⌄ Desktop" or a swipe down. Android/web: a full-screen
            // slide-up with the same bar as the way back.
            presentation: 'modal',
            animation: 'slide_from_bottom',
          }}
        />
      ))}
    </Stack>
  );
}
