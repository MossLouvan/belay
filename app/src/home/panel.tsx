// The slide-up tool panel's shared chrome.
//
// Desktop-first IA: Agent, Terminal, Files and System open OVER the live
// desktop, and every one of them must offer the same, unmissable way back.
// This wrapper adds that one thing — a slim top bar with a grab handle and a
// "⌄ Desktop" control — and floats the cross-surface "needs you" band over
// the panel's bottom edge, so an agent blocked on an approval can still reach
// you inside Terminal or Files. The tool's own screen renders unchanged
// beneath the bar; on iOS the panel is a native sheet, so swipe-down works
// too and the handle is drawn where the platform's own sheets draw theirs.

import React, { useCallback } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Label, Txt, haptic } from '../ui';
import { NeedsYouBanner } from '../agent/needs-you-banner';

/** The sheet-style grab handle: platform furniture, drawn once, centred. */
const HANDLE = { width: 36, height: 4 } as const;

export interface ToolPanelProps {
  children: React.ReactNode;
  testID?: string;
}

export function ToolPanel({ children, testID }: ToolPanelProps) {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const close = useCallback(() => {
    haptic('light');
    // The stack is anchored on the desktop, so back always lands there; the
    // navigate fallback covers a cold start that arrived here directly.
    if (router.canGoBack()) router.back();
    else router.navigate('/screen');
  }, [router]);

  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <View
        style={{
          // iOS presents the panel as a native sheet (top inset 0); Android
          // slides it up full screen, where the bar owns the status-bar inset.
          paddingTop: insets.top + theme.space.xxs,
          borderBottomWidth: theme.layout.hairline,
          borderBottomColor: theme.colors.border,
        }}
      >
        <View style={{ alignItems: 'center', paddingTop: theme.space.xxs }}>
          <View
            style={{
              width: HANDLE.width,
              height: HANDLE.height,
              borderRadius: HANDLE.height / 2,
              backgroundColor: theme.colors.border,
            }}
          />
        </View>
        <Pressable
          testID="panel-close"
          accessibilityRole="button"
          accessibilityLabel="Back to the desktop"
          accessibilityHint={Platform.OS === 'ios' ? 'You can also swipe down' : undefined}
          hitSlop={theme.layout.hitSlop}
          onPress={close}
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space.xxs,
            minHeight: theme.layout.minTouch,
            paddingHorizontal: theme.layout.margin,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Txt variant="label" tone="dim">
            {'⌄'}
          </Txt>
          <Label>Desktop</Label>
        </Pressable>
      </View>
      {/* The bar above has already spent the top inset (real on Android's
          full-screen slide-up, zero inside iOS's native sheet). The tool
          screens still pad themselves with `insets.top`, so hand them a
          zeroed top inset rather than editing every header. */}
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
        <View style={{ flex: 1, overflow: 'hidden' }}>{children}</View>
      </SafeAreaInsetsContext.Provider>
      {/* Approvals must reach you in every tool, not only on the desktop. */}
      <NeedsYouBanner bottom={0} />
    </View>
  );
}
