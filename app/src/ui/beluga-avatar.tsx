// The beluga: Belay's mark, drawn once, quietly.
//
// One closed silhouette in one flat colour (no gradient, glow, shadow or
// highlight), the same drawing as assets/beluga-mark.svg, the app icon and
// the desktop tray. A beluga in profile facing left: the melon (the rounded
// forehead belugas are known for) leads over a short beak, the tail curls up
// into a horizontal fluke (a whale's, not a fish's), and a flipper breaks the
// belly line. The eye and smile are holes in the path (wound against the
// body), so the mark needs no second colour and is right on any surface.
// `textDim` by default: at full `text` weight it outshouts the wordmark.

import React from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { haptic } from './haptics';

/** The silhouette in a 64×64 box (viewBox origin 2,4): body, flipper, eye, smile. */
export const BELUGA_PATH =
  'M7 43C3 41 4 37 9 36.5C4 33 3 22 10 17C15 13 19 12 23 12C34 11 42 17 45 27C47 33 50 36 53 34'
  + 'C55 32 55 27 53 23C50 22 48 20 47 17C51 17 54 18 56 20C58 17 61 15 64 15C63 19 61 22 59 24'
  + 'C61 32 60 40 54 45C46 52 32 54 22 52C13 51 8 48 7 43Z'
  + 'M24 50C29 51 33 55 33 60C28 59 24 56 22 51Z'
  + 'M15.6 26a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0Z'
  + 'M10 37.5C13 40.6 17 40.8 20.5 38.4C17 39.6 13 39.6 10 37.5Z';

export interface BelugaAvatarProps {
  /** Drawn width in points. Capped at 40 — this is a mark, not an illustration. */
  size: number;
  onPress?: () => void;
  /** Fill. Defaults to `textDim`. */
  color?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function BelugaAvatar({
  size, onPress, color, accessibilityLabel = 'Belay', style, testID,
}: BelugaAvatarProps) {
  const theme = useTheme();
  const width = Math.min(size, 40);
  const mark = (
    <Svg width={width} height={width} viewBox="2 4 64 64">
      <Path fill={color ?? theme.colors.textDim} d={BELUGA_PATH} />
    </Svg>
  );

  if (!onPress) {
    return (
      <View testID={testID} style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {mark}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => { haptic('light'); onPress(); }}
      style={({ pressed }) => [
        { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 },
        style,
      ]}
    >
      {mark}
    </Pressable>
  );
}
