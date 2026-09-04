// Root navigator and the app-wide chrome that belongs above every route:
// theme restoration, status-bar style, safe-area context, and the boot gate that
// keeps the connect screen from flashing before we know whether we are paired.

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, LogBox, Platform, View } from 'react-native';
import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts, Outfit_400Regular, Outfit_500Medium, Outfit_600SemiBold, Outfit_700Bold } from '@expo-google-fonts/outfit';
import { ConnectionProvider, useConnection } from '../src/connection';
import { useTheme } from '../src/theme';
import { restoreThemeMode } from '../src/settings/theme-mode';
import { LogoMark } from '../src/connect/brand';
import {
  AgentLink, parseAgentLink, planAgentLink, sessionKnown, settlePendingOpen,
} from '../src/agent/deep-link';
import { getAttention, refreshAttention, setOpenSession } from '../src/agent/attention-store';

// Keep the splash screen visible while fonts load
SplashScreen.preventAutoHideAsync().catch(() => undefined);

// The app intentionally registers two URI schemes (belay + the load-bearing
// `tether` compat scheme), so expo-router notes that it picked one prefix. That
// notice is expected config, not a defect — silence it so the dev LogBox stays
// clean. (No blanket suppression; this matches only that one message.)
LogBox.ignoreLogs([/multiple possible URI schemes/i]);

/**
 * Longest we will hold the splash waiting for stored state. If the storage read
 * never settles we still show the app rather than a permanently blank screen.
 */
const MAX_BOOT_WAIT_MS = 2500;

/** Branded hold-screen. Identical background to the splash, so the seam is invisible. */
function Boot() {
  const theme = useTheme();
  return (
    <View
      accessibilityLabel="Starting Belay"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bg }}
    >
      <LogoMark />
    </View>
  );
}

/**
 * Notification deep links: `belay://agent?host=<hostId>&session=<id>`.
 *
 * Every host notification carries that URL (docs/AGENT.md "The deep link,
 * honestly"); this is the app half. The decision logic — what the URL means,
 * matching computers on their stable host id and never on an address — is pure
 * and lives in src/agent/deep-link.ts; this component is only the wiring:
 * listen, defer until the app can act, navigate.
 *
 * Both arrival shapes are covered: `getInitialURL` for a cold start (the tap
 * launched the app) and the `url` event for a warm one (the app was already
 * running). Either way the link is held in state until the saved computers
 * have loaded and the navigator is mounted, so a cold-start tap is never lost
 * to a race with boot.
 */
function AgentLinkHandler() {
  const router = useRouter();
  // Null until the root navigator has mounted; navigating before that throws.
  const navReady = useRootNavigationState()?.key != null;
  const { ready, devices, active, phase, switchTo } = useConnection();
  /** A parsed link waiting for boot/navigation to be ready to act on it. */
  const [incoming, setIncoming] = useState<AgentLink | null>(null);
  /** An open deferred until a host switch settles. */
  const [pending, setPending] = useState<AgentLink | null>(null);

  /**
   * Open the session, checking it still exists first. If the host has since
   * pruned it, land on that host's session list — where its absence is
   * visible — instead of opening a view of nothing. Runs after the switch's
   * attention reset (it awaits a network round trip), so the id it sets is
   * never wiped by the host-change cleanup in the tabs layout.
   */
  const openSession = useCallback(async (sessionId: string) => {
    await refreshAttention();
    setOpenSession(sessionKnown(getAttention().sessions, sessionId) ? sessionId : null);
  }, []);

  // Listen from the first render. Anything that is not an agent link (a
  // pairing QR, an arbitrary URL fired at our scheme) parses to null and is
  // ignored here — the pairing flow has its own scanner-side handling.
  useEffect(() => {
    const handle = (raw: string | null) => {
      if (!raw) return;
      const link = parseAgentLink(raw);
      if (link) setIncoming(link);
    };
    const sub = Linking.addEventListener('url', (event) => handle(event.url));
    Linking.getInitialURL().then(handle).catch(() => undefined);
    return () => sub.remove();
  }, []);

  // Act on a link once the stored computers are loaded and navigation works.
  useEffect(() => {
    if (!incoming || !ready || !navReady) return;
    setIncoming(null);

    const plan = planAgentLink(incoming, devices, active?.id ?? null);
    if (plan.kind === 'host-not-found') {
      // The computer was unpaired (or was never paired on this phone). Say so
      // rather than guessing at a different machine's session.
      Alert.alert(
        'Computer not paired',
        'This notification is from a computer that is no longer paired with this phone.',
      );
      return;
    }

    // Land on the Agent tab immediately, so even a slow switch shows the
    // honest "reaching the computer" state instead of an unrelated screen.
    router.navigate('/agent');
    if (plan.kind === 'open' && phase === 'connected') {
      void openSession(plan.sessionId);
      return;
    }
    // Another computer, or the right one but not currently reachable: switch
    // (a switch to the already-active computer just re-races its addresses)
    // and finish the open when the connection settles.
    setPending(incoming);
    void switchTo(incoming.hostId);
  }, [incoming, ready, navReady, devices, active, phase, router, switchTo, openSession]);

  // Settle a deferred open as the switch progresses. 'wait' leaves it for the
  // next phase change; 'drop' abandons it — the computer proved unreachable
  // (the tab is already saying so) or the user moved elsewhere meanwhile.
  useEffect(() => {
    if (!pending) return;
    const verdict = settlePendingOpen(pending, active?.id ?? null, phase);
    if (verdict === 'wait') return;
    setPending(null);
    if (verdict === 'open') void openSession(pending.sessionId);
  }, [pending, active, phase, openSession]);

  return null;
}

/** Routes, held back until the saved connection has been read. */
function Routes({ forced }: { forced: boolean }) {
  const theme = useTheme();
  const { ready } = useConnection();

  if (!ready && !forced) return <Boot />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.bg },
        animation: 'fade',
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="devices" />
      <Stack.Screen name="(home)" />
    </Stack>
  );
}

export default function RootLayout() {
  const theme = useTheme();
  const [themeReady, setThemeReady] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);

  // Load Outfit fonts for the UI (mono stack stays platform-default for machine data)
  const [fontsLoaded, fontError] = useFonts({
    Outfit_400Regular,
    Outfit_500Medium,
    Outfit_600SemiBold,
    Outfit_700Bold,
  });

  // Restore the saved appearance before the first paint so the app never
  // flashes the wrong palette.
  useEffect(() => {
    let live = true;
    restoreThemeMode().finally(() => {
      if (live) setThemeReady(true);
    });
    const timer = setTimeout(() => {
      if (live) setBootTimedOut(true);
    }, MAX_BOOT_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  // Hide splash screen once fonts are loaded and theme is ready
  useEffect(() => {
    if ((fontsLoaded || fontError) && themeReady) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [fontsLoaded, fontError, themeReady]);

  // Keep the native window background in step with the theme, so overscroll and
  // rotation never reveal a mismatched colour. Cosmetic, hence best-effort.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    SystemUI.setBackgroundColorAsync(theme.colors.bg).catch(() => undefined);
  }, [theme.colors.bg]);

  // Hold the boot screen until fonts load. If font loading fails, proceed anyway
  // (the app will fall back to system fonts).
  const ready = (fontsLoaded || fontError) && (themeReady || bootTimedOut);

  // A plain View, not GestureHandlerRootView: nothing here uses
  // react-native-gesture-handler — the screen surface is built on PanResponder
  // — and mounting its root view initialises the Reanimated worklets bridge,
  // which segfaults the JS runtime on this SDK. Reintroduce it only alongside
  // an actual gesture-handler gesture, and re-test on device if so.
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <SafeAreaProvider>
        <StatusBar style={theme.isDark ? 'light' : 'dark'} />
        <ConnectionProvider>
          {ready ? <Routes forced={bootTimedOut} /> : <Boot />}
          <AgentLinkHandler />
        </ConnectionProvider>
      </SafeAreaProvider>
    </View>
  );
}
