// The floating mascot button over the immersive picture (Parsec-style).
//
// The beluga used to sit in the HUD's top-right and only toggled the
// orientation latch; the way back to the auto-hidden control bar was a tab
// on the left edge that landed wherever the HUD's notices did not. Now the
// beluga IS that way back: tap it and the bar returns. Drag it and it goes
// where your thumb wants, snapping to the nearest edge on release; the spot
// is remembered per orientation (mascot-store.ts). The latch moved to the
// dock's Menu ("Keep the view upright").
//
// It claims every touch that starts on it and refuses to hand them over, so
// a drag can never leak to the stage as remote input. The maths — tap vs
// drag, the snap, the clamp off the HUD and inside the safe area — is pure
// (mascot-button.ts) and tested there.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { BelugaAvatar, haptic, useReducedMotion } from '../ui';
import { HUD } from './parts';
import {
  clampMascot,
  defaultMascotPlacement,
  isMascotDrag,
  MASCOT_BUTTON_SIZE,
  mascotX,
  snapMascot,
} from './mascot-button';
import type { MascotBounds } from './mascot-button';
import { loadMascotPlacements, persistMascotPlacement } from './mascot-store';
import type { MascotOrientation, MascotPlacements } from './mascot-store';

export interface FloatingMascotProps {
  readonly landscape: boolean;
  /** Bottom edge of the whole HUD block (row, strip, notices), in screen points. */
  readonly hudBottom: number;
  readonly accessibilityLabel: string;
  /** A tap: bring the control bar back. */
  readonly onPress: () => void;
  readonly testID?: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

export function FloatingMascot({ landscape, hudBottom, accessibilityLabel, onPress, testID }: FloatingMascotProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const orientation: MascotOrientation = landscape ? 'landscape' : 'portrait';

  const bounds = useMemo<MascotBounds>(
    () => ({ width, height, insets, hudTop: insets.top + theme.space.xs, hudBottom }),
    [width, height, insets, theme.space.xs, hudBottom],
  );

  const [saved, setSaved] = useState<MascotPlacements>({});
  useEffect(() => {
    let live = true;
    void loadMascotPlacements().then((placements) => { if (live) setSaved(placements); });
    return () => { live = false; };
  }, []);

  // Where it rests right now: the remembered spot for this orientation (or
  // its home), re-clamped for the screen it is actually on.
  const placement = clampMascot(saved[orientation] ?? defaultMascotPlacement(bounds), bounds);
  const rest = useMemo<Point>(
    () => ({ x: mascotX(placement.side, bounds), y: placement.y }),
    [placement.side, placement.y, bounds],
  );

  const pan = useRef(new Animated.ValueXY(rest)).current;
  const dragging = useRef(false);
  // Refs the responder reads at touch time; it is created once.
  const restRef = useRef(rest);
  restRef.current = rest;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const latest = useRef({ onPress, saved, orientation });
  latest.current = { onPress, saved, orientation };

  // Any change to the resting spot — a restore, a rotation, the HUD growing
  // a notice — glides the button there, unless a finger is on it.
  useEffect(() => {
    if (dragging.current) return;
    if (reduced) {
      pan.setValue(rest);
      return;
    }
    const spring = Animated.spring(pan, { toValue: rest, useNativeDriver: false });
    spring.start();
    return () => spring.stop();
  }, [pan, rest, reduced]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claim on touch-down and never yield: the stage below must not see
        // any part of this touch as remote input.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          dragging.current = true;
          pan.setOffset(restRef.current);
          pan.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
        onPanResponderRelease: (_event, gesture) => {
          pan.flattenOffset();
          dragging.current = false;
          if (!isMascotDrag(gesture.dx, gesture.dy)) {
            pan.setValue(restRef.current);
            haptic('light');
            latest.current.onPress();
            return;
          }
          const dropped = snapMascot(restRef.current.x + gesture.dx, restRef.current.y + gesture.dy, boundsRef.current);
          haptic('selection');
          const { saved: current, orientation: axis } = latest.current;
          void persistMascotPlacement(current, axis, dropped).then(setSaved);
        },
        onPanResponderTerminate: () => {
          pan.flattenOffset();
          dragging.current = false;
          pan.setValue(restRef.current);
        },
      }),
    [pan],
  );

  return (
    <Animated.View
      testID={testID}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Drag to move it; it snaps to the nearest edge."
      {...responder.panHandlers}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: MASCOT_BUTTON_SIZE,
        height: MASCOT_BUTTON_SIZE,
        borderRadius: MASCOT_BUTTON_SIZE / 2,
        backgroundColor: HUD.scrim,
        borderWidth: theme.layout.hairline,
        borderColor: HUD.hairline,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 4,
        transform: pan.getTranslateTransform(),
      }}
    >
      <BelugaAvatar size={40} backgroundColor={HUD.scrim} />
    </Animated.View>
  );
}
