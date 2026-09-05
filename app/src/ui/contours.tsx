// Topographic contours — the "unclimbed terrain" garnish (REVAMP-SPEC §6.6).
//
// Concentric, hand-offset contour lines drawn as nested hairline rings, at
// ~4.5% ink (`contour` on paper, `machineLine` on the glass). The spec allows
// them in exactly three places — the connect screen, the glass empty states,
// and the My Computers empty state — and nowhere near data. They are pure
// decoration: hidden from assistive tech, transparent to touches, and they
// carry no meaning a reader could miss.
//
// react-native-svg is not a dependency, so each contour is a positioned View
// with asymmetric corner radii — offset unevenly from its neighbours so the
// rings read as surveyed terrain rather than a perfect bullseye.

import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { DimensionValue, StyleProp, ViewStyle } from 'react-native';
import { layout, useTheme } from '../theme';

/** One contour line: uneven insets + uneven corners = hand-drawn terrain. */
interface ContourRing {
  readonly top: DimensionValue;
  readonly left: DimensionValue;
  readonly right: DimensionValue;
  readonly bottom: DimensionValue;
  /** Corner radii, clockwise from top-left. */
  readonly radii: readonly [number, number, number, number];
}

/**
 * Outermost → innermost. The offsets drift down-and-right a little more with
 * each step, the way contour lines crowd toward a summit that is never quite
 * centred. Frozen: the terrain is data, not something call sites reshape.
 */
const RINGS: readonly ContourRing[] = Object.freeze([
  { top: '4%', left: '3%', right: '9%', bottom: '13%', radii: [150, 90, 130, 70] },
  { top: '15%', left: '13%', right: '17%', bottom: '23%', radii: [120, 72, 104, 58] },
  { top: '26%', left: '24%', right: '24%', bottom: '32%', radii: [96, 58, 84, 48] },
  { top: '37%', left: '35%', right: '30%', bottom: '40%', radii: [74, 46, 66, 38] },
]);

export interface ContoursProps {
  /**
   * On the machine glass the lines draw in `machineLine` (paper inks never
   * touch the glass — REVAMP-SPEC §3.1) and the innermost ring is dropped so
   * the centred §11.4 anatomy sits on clear ground. Off glass — the connect
   * screen, the My Computers empty state — they draw in `contour`.
   */
  onGlass?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Decorative topo ground. Fills its parent (absolute), clips its own rings,
 * never intercepts a touch, never reaches a screen reader.
 */
export function Contours({ onGlass = false, style }: ContoursProps) {
  const theme = useTheme();
  const ink = onGlass ? theme.colors.machineLine : theme.colors.contour;
  const rings = onGlass ? RINGS.slice(0, RINGS.length - 1) : RINGS;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[ { pointerEvents: 'none' },styles.ground, style]}
    >
      {rings.map((ring, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            top: ring.top,
            left: ring.left,
            right: ring.right,
            bottom: ring.bottom,
            borderWidth: layout.hairline,
            borderColor: ink,
            borderTopLeftRadius: ring.radii[0],
            borderTopRightRadius: ring.radii[1],
            borderBottomRightRadius: ring.radii[2],
            borderBottomLeftRadius: ring.radii[3],
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  ground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
});
