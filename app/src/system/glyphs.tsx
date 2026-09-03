// Tiny outline glyphs for the System stat cards — the reference dashboard puts
// a quiet line icon in each stat tile's trailing corner. Drawn from Views with
// the tab bar's 1.5pt stroke language (no icon font in this app), inked in
// `textFaint` so they read as furniture, never as data.

import React from 'react';
import { View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { useTheme } from '../theme';

const STROKE = 1.5;
const BOX: ViewStyle = { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' };

/** Chip: a square die with a solid core. CPU. */
export function ChipGlyph() {
  const theme = useTheme();
  const color = theme.colors.textFaint;
  return (
    <View style={BOX} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={{ width: 12, height: 12, borderRadius: 2, borderWidth: STROKE, borderColor: color }} />
      <View style={{ position: 'absolute', width: 4, height: 4, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

/** Stacked slats, like DIMM sticks. Memory. */
export function MemGlyph() {
  const theme = useTheme();
  const color = theme.colors.textFaint;
  return (
    <View
      style={[BOX, { gap: 2 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={{ width: 12, height: 3.5, borderRadius: 1, borderWidth: STROKE, borderColor: color }} />
      <View style={{ width: 12, height: 3.5, borderRadius: 1, borderWidth: STROKE, borderColor: color }} />
      <View style={{ width: 12, height: 3.5, borderRadius: 1, borderWidth: STROKE, borderColor: color }} />
    </View>
  );
}

/** A platter: ring with a centre point. Disk. */
export function DiskGlyph() {
  const theme = useTheme();
  const color = theme.colors.textFaint;
  return (
    <View style={BOX} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={{ width: 13, height: 13, borderRadius: 6.5, borderWidth: STROKE, borderColor: color }} />
      <View style={{ position: 'absolute', width: 3, height: 3, borderRadius: 1.5, backgroundColor: color }} />
    </View>
  );
}

/** Battery outline with its terminal nub. Power. */
export function PowerGlyph() {
  const theme = useTheme();
  const color = theme.colors.textFaint;
  return (
    <View
      style={[BOX, { flexDirection: 'row', gap: 1 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={{ width: 11, height: 7, borderRadius: 2, borderWidth: STROKE, borderColor: color }} />
      <View style={{ width: 2, height: 4, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}
