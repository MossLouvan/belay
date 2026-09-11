// The control column's two homes. Portrait docks it under the panel's rule;
// immersive floats it over the picture on the HUD scrim, with the auto-hide
// fade and the deliberate Hide chevron on its top edge.

import React from 'react';
import { Animated, View } from 'react-native';
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Rule } from '../ui';
import { ChevronGlyph, HUD, StageButton } from './parts';

export interface DockedControlsProps {
  readonly children: ReactNode;
}

export function DockedControls({ children }: DockedControlsProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingHorizontal: theme.layout.margin }}>
      {/* Additional vertical spacing to prevent bottom text overlap on Android
          and ensure adequate clearance above system navigation/taskbar. */}
      <View style={{ paddingTop: theme.space.xs, paddingBottom: 0 }}>{children}</View>
    </View>
  );
}

export interface FloatingDockProps {
  /** Whether the bar is on screen; off screen it stops catching touches too. */
  readonly shown: boolean;
  readonly opacity: Animated.Value;
  readonly onHide: () => void;
  readonly children: ReactNode;
}

export function FloatingDock({ shown, opacity, onHide, children }: FloatingDockProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Animated.View
      style={{
        pointerEvents: shown ? 'box-none' : 'none',
        position: 'absolute',
        left: insets.left + theme.space.sm,
        right: insets.right + theme.space.sm,
        bottom: insets.bottom + theme.space.sm,
        zIndex: 5,
        opacity,
      }}
    >
      {/* The deliberate dismiss: a labelled chevron riding the bar's top
          edge. Its counterpart — the ONLY way back by touch — is the
          bottom-edge swipe (EdgeRevealStrip in the route). */}
      <View style={{ alignItems: 'flex-end', marginBottom: theme.space.xxs }}>
        <StageButton
          testID="dock-hide"
          glyph={<ChevronGlyph direction="down" color={HUD.ink} />}
          label="Hide"
          accessibilityLabel="Hide the control bar. Swipe up from the bottom edge to bring it back."
          onPress={onHide}
        />
      </View>
      {children}
    </Animated.View>
  );
}
