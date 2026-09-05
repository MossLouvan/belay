// The collaborator cursors themselves, drawn over the live frame.
//
// One arrow per person in the colour the host assigned them, with a small
// name tag beside it. Everything here is view-drawn in the same style as the
// glyphs in parts.tsx — no icon font, no image, nothing to fetch — so the
// overlay costs a handful of Views and survives being rendered at 20 Hz.
//
// Geometry and colour decisions live in cursors.ts, which is JSX-free and
// tested; this file is the paint.

import React from 'react';
import { View } from 'react-native';
import type { ViewStyle } from 'react-native';

import { Micro } from '../ui';
import { TAG_HEIGHT, inkOn, placeTag, toPixels, visibleCursors } from './cursors';
import type { CursorSurface } from './cursors-store';
import type { RemoteCursor } from './cursors';

/** Arrow footprint. Small enough to point precisely, big enough to find. */
const ARROW = 16;

/**
 * A pointer, drawn as two rotated bars meeting at the hotspot.
 *
 * The dark seam under the coloured arms is what keeps a light pastel visible
 * over a white document — without it a pale cursor simply disappears against
 * the very backgrounds pastels look best on.
 */
function Arrow({ color, solid }: { color: string; solid: boolean }) {
  const arm = (rotate: string, length: number): ViewStyle => ({
    position: 'absolute',
    top: 0,
    left: ARROW / 2 - 1.5,
    width: 3,
    height: length,
    backgroundColor: color,
    borderRadius: 1.5,
    transform: [{ translateY: length / 2 }, { rotate }, { translateY: -length / 2 }],
  });
  const seam = (rotate: string, length: number): ViewStyle => ({
    ...arm(rotate, length),
    left: ARROW / 2 - 2.5,
    width: 5,
    backgroundColor: 'rgba(0,0,0,0.45)',
  });
  return (
    <View style={{ width: ARROW, height: ARROW }} pointerEvents="none">
      <View style={seam('20deg', ARROW)} />
      <View style={seam('68deg', ARROW * 0.72)} />
      <View style={arm('20deg', ARROW)} />
      <View style={arm('68deg', ARROW * 0.72)} />
      {/* Filled while this person holds the input floor: a hollow cursor is
          pointing, a solid one can actually click. */}
      <View
        style={{
          position: 'absolute',
          top: ARROW * 0.42,
          left: ARROW / 2 - 3,
          width: 6,
          height: 6,
          borderRadius: 3,
          borderWidth: solid ? 0 : 1.5,
          borderColor: color,
          backgroundColor: solid ? color : 'transparent',
        }}
      />
    </View>
  );
}

function Tag({ cursor, left, top }: { cursor: RemoteCursor; left: number; top: number }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left,
        top,
        height: TAG_HEIGHT,
        paddingHorizontal: 6,
        justifyContent: 'center',
        backgroundColor: cursor.color,
        // Square corners are the system (docs/DESIGN.md); 2pt is the standard
        // step, and the tag is a chip, not a card.
        borderRadius: 2,
      }}
    >
      <Micro style={{ color: inkOn(cursor.color) }} numberOfLines={1}>
        {cursor.name || 'someone'}
      </Micro>
    </View>
  );
}

export interface RemoteCursorsProps {
  readonly cursors: readonly RemoteCursor[];
  readonly selfId: string | null;
  /** The frame's rendered size, so normalized coordinates land on the pixels
   *  the picture is actually showing. */
  readonly width: number;
  readonly height: number;
  /** Which monitor or window is on screen; cursors elsewhere are not drawn. */
  readonly surface?: CursorSurface;
}

/**
 * Every collaborator's cursor, positioned over the frame.
 *
 * Absolutely positioned and `pointerEvents: none` throughout: this layer must
 * never intercept a touch meant for the desktop underneath it.
 */
export function RemoteCursors({
  cursors, selfId, width, height, surface = {},
}: RemoteCursorsProps) {
  // Nothing sensible to draw against a zero-sized frame — and dividing into one
  // would put NaN offsets into layout.
  if (width <= 0 || height <= 0) return null;

  const shown = visibleCursors(cursors, selfId, surface);
  if (shown.length === 0) return null;

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, width, height }}
    >
      {shown.map((c) => {
        const { x, y } = toPixels(c, width, height);
        const tag = placeTag(x, y, c.name || 'someone', width, height);
        return (
          <React.Fragment key={c.id}>
            <View
              pointerEvents="none"
              style={{ position: 'absolute', left: x, top: y }}
            >
              <Arrow color={c.color} solid={c.acting} />
            </View>
            <Tag cursor={c} left={tag.left} top={tag.top} />
          </React.Fragment>
        );
      })}
    </View>
  );
}
