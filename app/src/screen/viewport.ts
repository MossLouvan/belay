// The interaction model for the remote stage.
//
// One finger: tap clicks, long press right-clicks, and a drag either pans the
// picture (when zoomed in), drags the host mouse (touch mode at 1x) or nudges
// the cursor (trackpad mode). Two fingers: pinch zooms the view, drag sends the
// scroll wheel. Panning carries momentum unless reduced motion is on.
//
// Built on RN's PanResponder and Animated rather than gesture-handler +
// reanimated: reanimated is not a dependency of this app and the SDK is pinned,
// and PanResponder behaves identically in Expo Go and in the browser.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  GestureResponderEvent,
  GestureResponderHandlers,
  NativeTouchEvent,
  PanResponder,
  PanResponderGestureState,
} from 'react-native';
import { api } from '../api';
import { haptic } from '../ui';
import { clamp, clamp01, GESTURE, messageOf, numberOf, Size } from './model';
import {
  geometryOf,
  GestureRecord,
  identifierOf,
  newGesture,
  Origin,
  touchPoint,
  trackedPair,
} from './touches';

export type PointerMode = 'touch' | 'trackpad';

/** A one-shot button override armed by the Right-click / Double-click chips. */
export type PendingButton = 'none' | 'right' | 'double';

/** Page coordinate of the stage's top-left corner, from the event itself. */
const originOf = (event: GestureResponderEvent): Origin => ({
  x: numberOf(event.nativeEvent.pageX) - numberOf(event.nativeEvent.locationX),
  y: numberOf(event.nativeEvent.pageY) - numberOf(event.nativeEvent.locationY),
});

export interface ViewportOptions {
  /** Live size of the stage in px. A ref so the responder is built only once. */
  readonly sizeRef: React.MutableRefObject<Size>;
  readonly mode: PointerMode;
  readonly button: PendingButton;
  readonly onButtonUsed: () => void;
  readonly onError: (message: string) => void;
  readonly reducedMotion: boolean;
  /** Suppresses input calls that macOS would silently drop anyway. */
  readonly inputBlocked: boolean;
}

export interface Viewport {
  readonly translateX: Animated.Value;
  readonly translateY: Animated.Value;
  readonly scale: Animated.Value;
  readonly cursorX: Animated.Value;
  readonly cursorY: Animated.Value;
  readonly zoom: number;
  readonly handlers: GestureResponderHandlers;
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
}

export function useViewport(options: ViewportOptions): Viewport {
  const { sizeRef, mode, button, onButtonUsed, onError, reducedMotion, inputBlocked } = options;

  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scaleValue = useRef(new Animated.Value(1)).current;
  const cursorX = useRef(new Animated.Value(0)).current;
  const cursorY = useRef(new Animated.Value(0)).current;

  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const cursor = useRef({ x: 0.5, y: 0.5 });
  const gesture = useRef<GestureRecord>(newGesture());
  const momentum = useRef<number | null>(null);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastMoveAt = useRef(0);
  const lastScrollAt = useRef(0);
  const [zoom, setZoom] = useState(1);

  const modeRef = useRef(mode);
  const buttonRef = useRef(button);
  const blockedRef = useRef(inputBlocked);
  const reducedRef = useRef(reducedMotion);
  const onErrorRef = useRef(onError);
  const onButtonUsedRef = useRef(onButtonUsed);

  useEffect(() => {
    modeRef.current = mode;
    buttonRef.current = button;
    blockedRef.current = inputBlocked;
    reducedRef.current = reducedMotion;
    onErrorRef.current = onError;
    onButtonUsedRef.current = onButtonUsed;
  }, [mode, button, inputBlocked, reducedMotion, onError, onButtonUsed]);

  const send = useCallback((run: () => Promise<unknown>, what: string): void => {
    if (blockedRef.current) return;
    run().catch((e: unknown) => onErrorRef.current(`${what} failed — ${messageOf(e)}`));
  }, []);

  const applyView = useCallback(() => {
    const { scale, tx, ty } = view.current;
    translateX.setValue(tx);
    translateY.setValue(ty);
    scaleValue.setValue(scale);
  }, [scaleValue, translateX, translateY]);

  /** Moves the picture, keeping it covering the stage at the current zoom. */
  const setTranslate = useCallback(
    (tx: number, ty: number) => {
      const { w, h } = sizeRef.current;
      const scale = view.current.scale;
      const maxX = Math.max(0, ((scale - 1) * w) / 2);
      const maxY = Math.max(0, ((scale - 1) * h) / 2);
      view.current = { scale, tx: clamp(tx, -maxX, maxX), ty: clamp(ty, -maxY, maxY) };
      applyView();
    },
    [applyView, sizeRef]
  );

  const stopMomentum = useCallback(() => {
    if (momentum.current === null) return;
    cancelAnimationFrame(momentum.current);
    momentum.current = null;
  }, []);

  const startMomentum = useCallback(
    (vx: number, vy: number) => {
      if (reducedRef.current) return;
      let px = vx * GESTURE.frameMs;
      let py = vy * GESTURE.frameMs;
      const spent = (): boolean =>
        Math.abs(px) < GESTURE.minMomentumPx && Math.abs(py) < GESTURE.minMomentumPx;
      if (spent()) return;
      const step = (): void => {
        px *= GESTURE.friction;
        py *= GESTURE.friction;
        if (spent()) {
          momentum.current = null;
          return;
        }
        setTranslate(view.current.tx + px, view.current.ty + py);
        momentum.current = requestAnimationFrame(step);
      };
      momentum.current = requestAnimationFrame(step);
    },
    [setTranslate]
  );

  /** Zooms about a focal point expressed in stage coordinates. */
  const zoomTo = useCallback(
    (nextScale: number, focalX: number, focalY: number) => {
      const { w, h } = sizeRef.current;
      const from = view.current;
      const target = clamp(nextScale, GESTURE.minScale, GESTURE.maxScale);
      const ratio = target / from.scale;
      const tx = (focalX - w / 2) * (1 - ratio) + from.tx * ratio;
      const ty = (focalY - h / 2) * (1 - ratio) + from.ty * ratio;
      view.current = { scale: target, tx, ty };
      setTranslate(tx, ty);
      setZoom(Math.round(target * 10) / 10);
    },
    [setTranslate, sizeRef]
  );

  const zoomBy = useCallback(
    (factor: number) => {
      // No haptic here: the control that calls this owns the feedback.
      const { w, h } = sizeRef.current;
      stopMomentum();
      zoomTo(view.current.scale * factor, w / 2, h / 2);
    },
    [sizeRef, stopMomentum, zoomTo]
  );

  const reset = useCallback(() => {
    stopMomentum();
    view.current = { scale: 1, tx: 0, ty: 0 };
    applyView();
    setZoom(1);
  }, [applyView, stopMomentum]);

  /** Stage point -> normalized host coordinate, undoing the view transform. */
  const toHost = useCallback(
    (x: number, y: number): { x: number; y: number } => {
      const { w, h } = sizeRef.current;
      if (w <= 0 || h <= 0) return { x: 0.5, y: 0.5 };
      const { scale, tx, ty } = view.current;
      return {
        x: clamp01((x - w / 2 - tx) / scale / w + 0.5),
        y: clamp01((y - h / 2 - ty) / scale / h + 0.5),
      };
    },
    [sizeRef]
  );

  const paintCursor = useCallback(() => {
    const { w, h } = sizeRef.current;
    cursorX.setValue(cursor.current.x * w);
    cursorY.setValue(cursor.current.y * h);
  }, [cursorX, cursorY, sizeRef]);

  const flushCursorMove = useCallback(() => {
    lastMoveAt.current = Date.now();
    const { x, y } = cursor.current;
    send(() => api.move(x, y), 'Cursor move');
  }, [send]);

  /** Rate-limits `/input/move` to one call per `moveThrottleMs`, with a trailing send. */
  const queueCursorMove = useCallback(() => {
    const wait = GESTURE.moveThrottleMs - (Date.now() - lastMoveAt.current);
    if (wait <= 0) {
      flushCursorMove();
      return;
    }
    if (moveTimer.current) return;
    moveTimer.current = setTimeout(() => {
      moveTimer.current = undefined;
      flushCursorMove();
    }, wait);
  }, [flushCursorMove]);

  const nudgeCursor = useCallback(
    (dx: number, dy: number) => {
      const { w, h } = sizeRef.current;
      if (w <= 0 || h <= 0) return;
      // Dividing by the zoom makes the trackpad finer the further you zoom in,
      // which is the whole point of the mode.
      const gain = GESTURE.trackpadGain / view.current.scale;
      cursor.current = {
        x: clamp01(cursor.current.x + (dx * gain) / w),
        y: clamp01(cursor.current.y + (dy * gain) / h),
      };
      paintCursor();
      queueCursorMove();
    },
    [paintCursor, queueCursorMove, sizeRef]
  );

  const clickAt = useCallback(
    (point: { x: number; y: number }) => {
      const pending = buttonRef.current;
      haptic(pending === 'none' ? 'light' : 'medium');
      send(
        () => api.click(point.x, point.y, pending === 'right' ? 'right' : 'left', pending === 'double'),
        'Click'
      );
      if (pending !== 'none') onButtonUsedRef.current();
    },
    [send]
  );

  const emitScroll = useCallback(
    (dyPx: number, dxPx: number): boolean => {
      const notches = (px: number): number =>
        clamp(Math.trunc(px / GESTURE.pxPerScrollNotch), -GESTURE.maxNotchesPerSend, GESTURE.maxNotchesPerSend);
      const dy = notches(dyPx);
      const dx = notches(dxPx);
      if (dy === 0 && dx === 0) return false;
      lastScrollAt.current = Date.now();
      send(() => api.scroll(dy, dx), 'Scroll');
      return true;
    },
    [send]
  );

  const cancelLongPress = useCallback(() => {
    const g = gesture.current;
    if (!g.longPress) return;
    clearTimeout(g.longPress);
    g.longPress = undefined;
  }, []);

  /**
   * (Re)anchors the two-finger gesture to the two fingers currently down.
   *
   * Called when no pair is being followed yet and whenever one of the followed
   * fingers lifts. Re-baselining the pinch distance and scroll anchor here is
   * what stops the zoom/scroll "pop" that switching fingers would otherwise
   * cause; an already-classified gesture keeps its intent.
   */
  const rebaselineTwoFingers = useCallback(
    (touches: readonly NativeTouchEvent[], origin: Origin) => {
      const g = gesture.current;
      const [first, second] = touches;
      const { distance, centerX, centerY } = geometryOf(touchPoint(first, origin), touchPoint(second, origin));
      const classified = g.kind === 'zoom' || g.kind === 'scroll';
      if (!classified) cancelLongPress();
      gesture.current = {
        ...g,
        kind: classified ? g.kind : 'pendingTwo',
        touchA: identifierOf(first),
        touchB: identifierOf(second),
        pinchDistance: distance || 1,
        twoStartX: centerX,
        twoStartY: centerY,
        baseScale: view.current.scale,
        scrollX: centerX,
        scrollY: centerY,
        longPress: classified ? g.longPress : undefined,
      };
    },
    [cancelLongPress]
  );

  /** Classifies a two-finger gesture once, then keeps serving that intent. */
  const handleTwoFingers = useCallback(
    (touches: readonly NativeTouchEvent[], origin: Origin) => {
      const g = gesture.current;
      const following = g.kind === 'zoom' || g.kind === 'scroll' || g.kind === 'pendingTwo';
      const pair = following ? trackedPair(touches, g) : null;
      if (!pair) {
        // Either this is the first move of the gesture, or one of the two
        // fingers we were following has lifted. Anchor to the current pair and
        // wait for the next move rather than measuring across the swap.
        rebaselineTwoFingers(touches, origin);
        return;
      }

      const { distance, centerX, centerY } = geometryOf(touchPoint(pair[0], origin), touchPoint(pair[1], origin));
      const ratio = distance / (g.pinchDistance || 1);
      if (g.kind === 'pendingTwo') {
        const moved = Math.hypot(centerX - g.twoStartX, centerY - g.twoStartY);
        if (Math.abs(ratio - 1) > GESTURE.pinchThreshold) g.kind = 'zoom';
        else if (moved > GESTURE.scrollThresholdPx) g.kind = 'scroll';
        else return;
      }

      if (g.kind === 'zoom') {
        zoomTo(g.baseScale * ratio, centerX, centerY);
        return;
      }
      if (Date.now() - lastScrollAt.current < GESTURE.scrollThrottleMs) return;
      if (emitScroll(centerY - g.scrollY, centerX - g.scrollX)) {
        g.scrollY = centerY;
        g.scrollX = centerX;
      }
    },
    [emitScroll, rebaselineTwoFingers, zoomTo]
  );

  const handleOneFinger = useCallback(
    (state: PanResponderGestureState) => {
      const g = gesture.current;
      if (g.kind === 'pending') {
        if (Math.hypot(state.dx, state.dy) < GESTURE.tapSlopPx) return;
        cancelLongPress();
        // At 1x there is nothing to pan, so a drag is a drag on the host.
        g.kind = modeRef.current === 'trackpad' ? 'cursor' : view.current.scale > 1 ? 'pan' : 'hostDrag';
      }
      if (g.kind === 'pan') {
        setTranslate(g.baseTx + state.dx, g.baseTy + state.dy);
        return;
      }
      if (g.kind === 'cursor') {
        nudgeCursor(state.dx - g.lastDx, state.dy - g.lastDy);
        g.lastDx = state.dx;
        g.lastDy = state.dy;
      }
    },
    [cancelLongPress, nudgeCursor, setTranslate]
  );

  const onGrant = useCallback(
    (event: GestureResponderEvent) => {
      stopMomentum();
      const x = numberOf(event.nativeEvent.locationX);
      const y = numberOf(event.nativeEvent.locationY);
      gesture.current = {
        ...newGesture(),
        kind: 'pending',
        startX: x,
        startY: y,
        baseTx: view.current.tx,
        baseTy: view.current.ty,
        baseScale: view.current.scale,
      };
      gesture.current.longPress = setTimeout(() => {
        const g = gesture.current;
        if (g.kind !== 'pending') return;
        g.kind = 'consumed';
        g.longPress = undefined;
        haptic('medium');
        const target = modeRef.current === 'trackpad' ? cursor.current : toHost(g.startX, g.startY);
        send(() => api.click(target.x, target.y, 'right', false), 'Right-click');
      }, GESTURE.longPressMs);
    },
    [send, stopMomentum, toHost]
  );

  const onRelease = useCallback(
    (event: GestureResponderEvent, state: PanResponderGestureState) => {
      cancelLongPress();
      const g = gesture.current;
      gesture.current = newGesture();
      if (g.kind === 'pending') {
        clickAt(modeRef.current === 'trackpad' ? cursor.current : toHost(g.startX, g.startY));
        return;
      }
      if (g.kind === 'pan') {
        startMomentum(state.vx, state.vy);
        return;
      }
      if (g.kind === 'hostDrag') {
        const from = toHost(g.startX, g.startY);
        const to = toHost(numberOf(event.nativeEvent.locationX), numberOf(event.nativeEvent.locationY));
        send(() => api.drag(from.x, from.y, to.x, to.y), 'Drag');
      }
    },
    [cancelLongPress, clickAt, send, startMomentum, toHost]
  );

  const handlers = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: onGrant,
        onPanResponderMove: (event: GestureResponderEvent, state: PanResponderGestureState) => {
          const touches = event.nativeEvent.touches;
          if (touches && touches.length >= 2) {
            handleTwoFingers(touches, originOf(event));
            return;
          }
          const kind = gesture.current.kind;
          if (kind === 'zoom' || kind === 'scroll' || kind === 'consumed') return;
          handleOneFinger(state);
        },
        onPanResponderRelease: onRelease,
        onPanResponderTerminate: () => {
          cancelLongPress();
          gesture.current = newGesture();
        },
      }).panHandlers,
    [cancelLongPress, handleOneFinger, handleTwoFingers, onGrant, onRelease]
  );

  // Keep the crosshair pinned when the stage resizes or the zoom changes.
  useEffect(() => {
    paintCursor();
  }, [paintCursor, zoom]);

  useEffect(
    () => () => {
      stopMomentum();
      if (moveTimer.current) clearTimeout(moveTimer.current);
      if (gesture.current.longPress) clearTimeout(gesture.current.longPress);
    },
    [stopMomentum]
  );

  return { translateX, translateY, scale: scaleValue, cursorX, cursorY, zoom, handlers, zoomBy, reset };
}
