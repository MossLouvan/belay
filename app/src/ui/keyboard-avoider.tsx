// KeyboardAvoider — the app's one answer to "the keyboard is covering that".
//
// Wrap a surface in it and the surface holds a bottom inset exactly as tall
// as the keyboard's intrusion into it, animated on the keyboard's own
// duration and curve so the UI travels WITH the keys rather than snapping
// into place after them.
//
// Why not RN's KeyboardAvoidingView. KAV measures itself with onLayout, whose
// coordinates are relative to its parent, and then treats them as window
// coordinates. That is only true for a view that happens to start at the
// window's top-left and reach its bottom. In this app almost nothing does:
// the tool panels are native sheets over the desktop, they sit above a nav
// bar, and on Android they slide up full screen instead. Every call site was
// papering over the mismatch with a hand-tuned `keyboardVerticalOffset` (the
// agent session's was a flat 90), which is a per-device guess by definition —
// and on Android every one of them passed `behavior={undefined}`, which makes
// KAV do nothing at all. That is the "some pages don't move" bug.
//
// This measures the wrapper with measureInWindow at keyboard-event time, so
// the number is the real overlap on any device, in a sheet or out of one,
// with or without a nav bar beneath. The measured view's own frame never
// moves — the inset is applied to a child — so the measurement can never
// chase itself.
//
// It insets rather than translates on purpose: a scrollable inside it keeps
// its full scroll range and simply gets shorter, and a footer (the agent
// tab's Allow / Deny, the composer) rides up to sit on the keyboard's edge.
// Translating instead would push the footer up and the scrollable's bottom
// off the screen.
//
// The screen tab is deliberately NOT a client of this: its live video stage
// must not resize, so it floats one row on `useKeyboardLift` directly
// (src/screen/use-type-row.ts). Same hook, different application.

import React, { useRef } from 'react';
import { Animated, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useKeyboardLift } from './keyboard-lift';

export interface KeyboardAvoiderProps {
  children: React.ReactNode;
  /** Style for the outer (measured) view. Defaults to filling its parent. */
  style?: StyleProp<ViewStyle>;
  /**
   * Style for the inner view that actually carries the lift — put layout of
   * the children here (a sheet's `justifyContent: 'flex-end'`, say), not on
   * `style`, or it will be applied to a wrapper the children do not live in.
   */
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * A bottom safe-area inset the content already pads for. The keyboard
   * covers the home indicator while it is up, so that padding is absorbed
   * into the lift instead of stacking above the keys.
   */
  safeAreaBottom?: number;
  testID?: string;
}

export function KeyboardAvoider({ children, style, contentStyle, safeAreaBottom = 0, testID }: KeyboardAvoiderProps) {
  const anchor = useRef<View>(null);
  // 'layout' because paddingBottom resizes real layout, which the native
  // animation driver cannot do. The keyboard's own duration and curve still
  // apply, so the travel reads as one movement with the keys.
  const { lift } = useKeyboardLift(anchor, { driver: 'layout', safeAreaBottom });

  return (
    <View ref={anchor} testID={testID} style={[{ flex: 1 }, style]}>
      <Animated.View style={[{ flex: 1 }, contentStyle, { paddingBottom: lift }]}>{children}</Animated.View>
    </View>
  );
}
