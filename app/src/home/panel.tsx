// The slide-up tool panel's shared chrome.
//
// Desktop-first IA: Agent, Terminal, Files and System open OVER the live
// desktop, and every one of them must offer the same, unmissable way back.
//
// The concept mockups stand the whole app on a five-tab bar, and a tool that
// arrives with no tab bar reads as a different app — so this wrapper carries
// the same bar the desktop and the computers list do, with the tool's own tab
// lit. The way back to the desktop is the header's `‹ Desktop`, the same
// chevron-and-word row the desktop uses to reach the computers list, rather
// than a grab handle that only says "a sheet" and only on iOS. On iOS the
// panel is still a native sheet, so swipe-down keeps working alongside it.
//
// It also floats the cross-surface "needs you" band over the panel's bottom
// edge, so an agent blocked on an approval can still reach you inside Terminal
// or Files.

import React, { useCallback } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconChevronLeft } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { Txt, haptic } from '../ui';
import { NeedsYouBanner } from '../agent/needs-you-banner';
import { AppearanceNav } from './appearance-nav';
import type { NavTab } from './appearance-nav';

export interface ToolPanelProps {
  children: React.ReactNode;
  /** Which of the five tabs this panel is. Lights it in the bar. */
  tab: Exclude<NavTab, 'screen'>;
  testID?: string;
}

export function ToolPanel({ children, tab, testID }: ToolPanelProps) {
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
          paddingHorizontal: theme.layout.margin,
          paddingBottom: 0,
        }}
      >
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
            gap: 2,
            minHeight: theme.layout.minTouch,
            marginLeft: -6,
            opacity: pressed ? theme.motion.pressOpacity : 1,
          })}
        >
          <IconChevronLeft size={22} strokeWidth={2.2} color={theme.colors.text} />
          <Txt variant="body">Desktop</Txt>
        </Pressable>
      </View>
      {/* The bar above has already spent the top inset (real on Android's
          full-screen slide-up, zero inside iOS's native sheet). Provide a
          zeroed top inset to tool screens so they don't double-pad — the bar
          owns the status-bar clearance, not the children. */}
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
        <View style={{ flex: 1, overflow: 'hidden' }}>{children}</View>
      </SafeAreaInsetsContext.Provider>
      {/* Approvals must reach you in every tool, not only on the desktop. */}
      <NeedsYouBanner bottom={0} />
      <AppearanceNav selected={tab} />
    </View>
  );
}
