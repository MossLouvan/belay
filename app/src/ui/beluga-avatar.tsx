import React from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { haptic } from './haptics';

export interface BelugaAvatarProps {
  size: number;
  onPress?: () => void;
  backgroundColor?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Quiet, static identity. Existing orientation/menu actions stay intact. */
export function BelugaAvatar({ size, onPress, accessibilityLabel = 'Belay', style, testID }: BelugaAvatarProps) {
  const theme = useTheme();
  const width = Math.min(size, 40);
  const mark = <Svg width={width} height={width} viewBox="0 0 64 48" accessible={false}>
    <Path fill={theme.colors.textDim} d="M7 26C3 23 5 14 12 11C18 8 24 12 28 17C34 22 42 28 49 23C51 21 52 17 51 14C55 15 57 17 57 20C59 18 61 18 63 18C62 24 58 28 53 29C48 35 39 37 29 34C27 39 23 40 21 38L20 32C14 31 9 30 7 26Z" />
    <Circle cx="13" cy="21" r="1.3" fill={theme.colors.bg} />
  </Svg>;
  if (!onPress) return <View testID={testID} style={style} accessible={false}>{mark}</View>;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    onPress={() => { haptic('light'); onPress(); }}
    style={({ pressed }) => [{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }, style]}>
    {mark}
  </Pressable>;
}
