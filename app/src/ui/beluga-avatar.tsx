// The beluga — Belay's mark, drawn once, quietly.
//
// This replaced an animated cutout mascot that bobbed, span and flipped. The
// founder's brief for the replacement was exact: clean and discreet, not AI
// slop. So it is one closed silhouette in one flat colour — no gradient, no
// glow, no drop shadow, no highlight, no smile, no bubbles — sized to read at
// 26–28pt beside the wordmark without competing with it. `textDim` on purpose:
// at full `text` weight the mark outshouts the word it sits next to.
//
// The drawing is a beluga in profile facing right: the melon (the rounded
// forehead belugas are known for) leads, the back slopes back to a narrow
// peduncle, a small flipper breaks the belly line so it does not read as a
// fish, and the tail fluke is the notched V at the left. The eye is knocked
// out in the host background rather than painted, so the mark needs no second
// colour and stays correct on any surface it lands on.

import React from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { haptic } from './haptics';

/**
 * The silhouette, in a 64×40 box: one closed path for the body, one for the
 * pectoral flipper, and the eye knocked out of both.
 *
 * The proportions are the whole trick. A stout body barely twice as long as it
 * is deep, a melon that is the highest point of the animal, no dorsal fin at
 * all, and a fluke small enough and swept far enough back that it cannot be
 * mistaken for a caudal fin — those four are what separate a beluga from a
 * fish at 26pt, where no amount of detail survives.
 */
const BODY =
  'M18 17C24 12.4 32 9.6 40 8C48 6.4 57 8.6 61 14.6C63 18 62.4 22.6 58.4 25.4'
  + 'C54 28.4 46 30.4 38 30.6C30 30.8 23 28.6 18 24.6'
  + 'C15.4 25.6 12 26.6 8 27.8C6 28.4 5.2 28.6 4.6 28.8'
  + 'C7.4 26.6 10 24.2 12.2 22.2'
  + 'C10 20.8 7.4 19.2 4.6 17.4C5.2 17.4 6 17.6 8 18C12 18.8 15.4 18.4 18 17Z';

/** The pectoral flipper: a short paddle, not a fin. */
const FLIPPER = 'M40 29C38.6 32.6 35.6 35 32 35.6C32.8 32.2 35.4 29.6 38 28.6Z';

export interface BelugaAvatarProps {
  /** Drawn width in points. Capped at 40 — this is a mark, not an illustration. */
  size: number;
  onPress?: () => void;
  /** Colour knocked out of the eye. Defaults to the page ground. */
  backgroundColor?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function BelugaAvatar({
  size, onPress, backgroundColor, accessibilityLabel = 'Belay', style, testID,
}: BelugaAvatarProps) {
  const theme = useTheme();
  const width = Math.min(size, 40);
  const mark = (
    <Svg width={width} height={(width * 40) / 64} viewBox="0 0 64 40">
      <Path fill={theme.colors.textDim} d={BODY} />
      <Path fill={theme.colors.textDim} d={FLIPPER} />
      <Circle cx="52" cy="15" r="1.7" fill={backgroundColor ?? theme.colors.bg} />
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
