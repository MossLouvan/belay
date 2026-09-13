// The beluga — Belay's mark, drawn once, quietly.
//
// WHERE THIS BELONGS. Exactly one place: the first-run welcome hero, drawn
// large. It used to sit at 26pt beside the wordmark on the computers list, at
// 40pt in the tool drawer and at 48pt over the stream, and at those sizes it
// was not a beluga — it was a small grey fish. The melon (the domed forehead
// that is the animal's only unmistakable feature) needs real diameter before
// it reads as a bulge rather than a bump, and under about 64pt it simply does
// not survive. So the mark is now a hero illustration with a floor, the
// wordmark carries the chrome, and `MIN_MARK_SIZE` is enforced rather than
// documented-and-ignored — the previous version silently CAPPED size at 40,
// which is why even the welcome screen got the fish.
//
// WHAT IT IS. One closed silhouette in one flat colour — no gradient, no glow,
// no drop shadow, no highlight, no smile, no bubbles, and no press handler:
// every tap target this ever carried was a no-op, one of them advertising an
// animation that had been deleted. It is a picture, and it says so by being
// hidden from assistive technology; the words around it carry the meaning.
//
// THE DRAWING. A beluga in profile facing right. Four things separate it from
// a fish at a glance, and all four are load-bearing:
//   1. the MELON — a domed forehead that is both the highest point of the
//      animal and its leading mass, so the head reads blunt, never pointed;
//   2. NO DORSAL FIN — the back is one unbroken curve, the single clearest
//      "this is a whale" cue in a silhouette;
//   3. the FLUKE — short, blunt-lobed and swept back off a narrow peduncle,
//      so it cannot be mistaken for a fish's tall caudal fin;
//   4. the FLIPPER — a short rounded paddle set high and forward behind the
//      head, not a pointed fin halfway down the belly.
// The eye is knocked out in the host background rather than painted, so the
// mark needs no second colour and stays correct on any surface it lands on.

import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';

/** The drawing's aspect box. Every coordinate below lives in it. */
const VIEW_W = 64;
const VIEW_H = 40;

/**
 * The smallest width at which the silhouette still reads as a beluga rather
 * than a generic small fish. Below this the melon flattens into the skull line
 * and the fluke and flipper merge into the body, and what is left is a blob.
 * Enforced, not suggested: a caller asking for less gets this.
 */
export const MIN_MARK_SIZE = 64;

/** The body: melon, unbroken back, narrow peduncle, short blunt fluke. */
const BODY =
  'M62 18.4C62 11.4 56.6 5.6 49 5.6C43.4 5.6 38.6 8.8 36.4 13.4'
  + 'C29.6 14.4 22.4 16.8 16.8 19.6C13.6 17.6 9.6 15.8 6 14.8'
  + 'C7.4 17 9.2 19.2 10.8 20.8C9.2 22.6 7.4 24.8 6 27'
  + 'C9.6 26 13.6 24.2 16.8 22.2C22.4 27.2 30 30.8 38 31.6'
  + 'C46.6 32.4 55.4 29.2 59.6 24.6C61.2 22.8 62 20.8 62 18.4Z';

/** The pectoral flipper: a short rounded paddle, not a fin. */
const FLIPPER =
  'M46.4 29.2C46.2 33 43.4 36 39.6 36.8C38.4 37 37.8 36.4 38.2 35.2'
  + 'C39.2 32 42 29.6 45 28.4Z';

const EYE = Object.freeze({ cx: 53.5, cy: 16.4, r: 2 });

export interface BelugaAvatarProps {
  /** Drawn width in points. Raised to {@link MIN_MARK_SIZE} if smaller. */
  size: number;
  /** Colour knocked out of the eye. Defaults to the page ground. */
  backgroundColor?: string;
  /** Ink for the silhouette. Defaults to the quiet `textDim` role. */
  color?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function BelugaAvatar({ size, backgroundColor, color, style, testID }: BelugaAvatarProps) {
  const theme = useTheme();
  const width = Math.max(size, MIN_MARK_SIZE);
  const ink = color ?? theme.colors.textDim;

  return (
    <View
      testID={testID}
      style={style}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={width} height={(width * VIEW_H) / VIEW_W} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
        <Path fill={ink} d={BODY} />
        <Path fill={ink} d={FLIPPER} />
        <Circle cx={EYE.cx} cy={EYE.cy} r={EYE.r} fill={backgroundColor ?? theme.colors.bg} />
      </Svg>
    </View>
  );
}
