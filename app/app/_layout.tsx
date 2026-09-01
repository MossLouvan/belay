// Root navigator and the app-wide chrome that belongs above every route:
// theme restoration, status-bar style, safe-area context, and the boot gate that
// keeps the connect screen from flashing before we know whether we are paired.

import React, { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConnectionProvider, useConnection } from '../src/connection';
import { useTheme } from '../src/theme';
import { restoreThemeMode } from '../src/settings/theme-mode';
import { LogoMark } from '../src/connect/brand';

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
      accessibilityLabel="Starting Deskhandler"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bg }}
    >
      <LogoMark />
    </View>
  );
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
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

export default function RootLayout() {
  const theme = useTheme();
  const [themeReady, setThemeReady] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);

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

  // Keep the native window background in step with the theme, so overscroll and
  // rotation never reveal a mismatched colour. Cosmetic, hence best-effort.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    SystemUI.setBackgroundColorAsync(theme.colors.bg).catch(() => undefined);
  }, [theme.colors.bg]);

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
          {themeReady || bootTimedOut ? <Routes forced={bootTimedOut} /> : <Boot />}
        </ConnectionProvider>
      </SafeAreaProvider>
    </View>
  );
}
