// The interaction model for the remote stage.
//
// One finger: tap clicks, long press right-clicks, and a drag either pans the
// picture (when zoomed in), drags the host mouse (touch mode at 1x), nudges
// the cursor (trackpad mode) or sends the scroll wheel (scroll mode). Two
// fingers: pinch zooms the view about the fingers and drags it with them; a
// plain two-finger drag pans when zoomed in, sends the scroll wheel at 1x;
// a quick, still two-finger TAP right-clicks at the pair's centroid — the
// Mac trackpad's secondary click.
// Three fingers swipe between the host's desktops. Pans, pinch-drags and
// scroll-mode flicks carry momentum unless reduced motion is on.
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
import { clamp01, GESTURE, messageOf, numberOf, Size } from './model';
import {
  centroidOf,
  geometryOf,
  GestureRecord,
  identifierOf,
  isTwoFingerTap,
  newGesture,
  Origin,
  pairTapEligible,
  touchPoint,
  trackedPair,
  trackedTriple,
} from './touches';
import { classifyTwoFinger, clampTranslate, zoomAbout } from './pinch';
import { batchScroll, classifyOneFinger, decayStep, flickSpent, flickStep, scrollDue } from './scroll-mode';
import type { PointerMode, ScrollBatch } from './scroll-mode';
import { detectSwipe } from './swipe';
import type { SwipeDirection } from './swipe';

export type { PointerMode };

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
  /**
   * Monitor index the stream is showing (from `ScreenInfo.screens`), or
   * undefined for the host's primary. Sent with every click/move/drag so the
   * host maps our normalized 0..1 onto the monitor the user is LOOKING at —
   * capture and input disagreeing on the monitor was the multi-monitor bug.
   */
  readonly screen?: number;
  /**
   * Fired after any host-bound pointer action (click, right-click, drag).
   * The screen tab uses it to spend one-shot latched modifiers — the phone's
   * stand-in for letting go of Ctrl when you reach for the mouse. Pans, zooms
   * and scrolls do NOT fire it: they are viewing gestures, not input.
   */
  readonly onPointer?: () => void;
  /**
   * Active sticky-modifier names (host wire form, e.g. 'ctrl','shift','cmd') at
   * the moment of a click, so a latched modifier on the phone becomes a real
   * Ctrl+click / Shift+click. Read just before the click is sent; `onPointer`
   * then clears the one-shot latches. Undefined when no modifiers are in force.
   */
  readonly activeMods?: () => string[];
  /**
   * Fired once when a three-finger swipe commits to a direction. The screen
   * tab turns it into the desktop-switch chord for the host platform; the
   * viewport neither knows nor cares which keys those are.
   */
  readonly onSwipe?: (direction: SwipeDirection) => void;
  /**
   * Fired when a touch lands on the trackpad surface (`padHandlers`). The
   * screen tab uses it to surface the crosshair while the pad drives the
   * cursor, whatever the stage's own pointer mode is.
   */
  readonly onPadInput?: () => void;
}

export interface Viewport {
  readonly translateX: Animated.Value;
  readonly translateY: Animated.Value;
  readonly scale: Animated.Value;
  readonly cursorX: Animated.Value;
  readonly cursorY: Animated.Value;
  readonly zoom: number;
  readonly handlers: GestureResponderHandlers;
  /**
   * The same gesture vocabulary as `handlers`, pinned to trackpad (relative)
   * mode whatever the dock says: drag nudges the host cursor, tap clicks at
   * it, two-finger tap right-clicks, two fingers scroll, three fingers swipe.
   * For the DEADSPACE between the letterboxed picture and the control bar —
   * attached there, the black gap becomes a laptop trackpad instead of a
   * hole gestures fall through (the swipe-leak-to-device-switch bug).
   */
  readonly padHandlers: GestureResponderHandlers;
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
}

export function useViewport(options: ViewportOptions): Viewport {
  const { sizeRef, mode, button, onButtonUsed, onError, reducedMotion, inputBlocked, screen, onPointer, activeMods, onSwipe, onPadInput } =
    options;

  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scaleValue = useRef(new Animated.Value(1)).current;
  const cursorX = useRef(new Animated.Value(0)).current;
  const cursorY = useRef(new Animated.Value(0)).current;

  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const cursor = useRef({ x: 0.5, y: 0.5 });
  const gesture = useRef<GestureRecord>(newGesture());
  const momentum = useRef<number | null>(null);
  const scrollMomentum = useRef<number | null>(null);
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
  const screenRef = useRef(screen);
  const onPointerRef = useRef(onPointer);
  const activeModsRef = useRef(activeMods);
  const onSwipeRef = useRef(onSwipe);
  const onPadInputRef = useRef(onPadInput);

  // Whether the gesture in flight arrived through `padHandlers`. A ref, not
  // state: it must be readable synchronously inside responder callbacks, and
  // flipping it re-renders nothing.
  const padActive = useRef(false);

  /** The pointer mode this gesture obeys: the pad is ALWAYS a trackpad. */
  const effectiveMode = useCallback(
    (): PointerMode => (padActive.current ? 'trackpad' : modeRef.current),
    []
  );

  useEffect(() => {
    modeRef.current = mode;
    buttonRef.current = button;
    blockedRef.current = inputBlocked;
    reducedRef.current = reducedMotion;
    onErrorRef.current = onError;
    onButtonUsedRef.current = onButtonUsed;
    screenRef.current = screen;
    onPointerRef.current = onPointer;
    activeModsRef.current = activeMods;
    onSwipeRef.current = onSwipe;
    onPadInputRef.current = onPadInput;
  }, [mode, button, inputBlocked, reducedMotion, onError, onButtonUsed, screen, onPointer, activeMods, onSwipe, onPadInput]);

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
      view.current = { scale, ...clampTranslate(tx, ty, scale, w, h) };
      applyView();
    },
    [applyView, sizeRef]
  );

  /** Halts BOTH kinds of coasting — a touch anywhere catches the page. */
  const stopMomentum = useCallback(() => {
    if (momentum.current !== null) {
      cancelAnimationFrame(momentum.current);
      momentum.current = null;
    }
    if (scrollMomentum.current !== null) {
      cancelAnimationFrame(scrollMomentum.current);
      scrollMomentum.current = null;
    }
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
      const next = zoomAbout(view.current, nextScale, focalX, focalY, w, h, GESTURE);
      view.current = next;
      applyView();
      setZoom(Math.round(next.scale * 10) / 10);
    },
    [applyView, sizeRef]
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
    send(() => api.move(x, y, screenRef.current), 'Cursor move');
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

  // A tap awaiting double-tap confirmation: its single click is deferred by
  // GESTURE.doubleTapMs so a quick second tap can upgrade it to a double-click
  // (which the host sends as a real cc1+cc2). Only plain left taps defer;
  // armed R-CLICK/2×CLICK still fire instantly.
  const doubleTap = useRef<{ point: { x: number; y: number }; timer: ReturnType<typeof setTimeout> } | null>(null);

  const sendLeftClick = useCallback(
    (point: { x: number; y: number }, double: boolean) => {
      haptic(double ? 'medium' : 'light');
      const mods = activeModsRef.current?.();
      send(() => api.click(point.x, point.y, 'left', double, screenRef.current, mods), double ? 'Double-click' : 'Click');
      onPointerRef.current?.();
    },
    [send]
  );

  const clickAt = useCallback(
    (point: { x: number; y: number }) => {
      const pending = buttonRef.current;
      haptic(pending === 'none' ? 'light' : 'medium');
      // Snapshot the latched modifiers now; onPointer clears them right after.
      const mods = activeModsRef.current?.();
      send(
        () =>
          api.click(
            point.x,
            point.y,
            pending === 'right' ? 'right' : 'left',
            pending === 'double',
            screenRef.current,
            mods
          ),
        'Click'
      );
      if (pending !== 'none') onButtonUsedRef.current();
      onPointerRef.current?.();
    },
    [send]
  );

  // Route a stage tap: an armed one-shot (right/double) fires immediately; a
  // plain tap defers briefly so a second tap nearby becomes a double-click.
  const handleTap = useCallback(
    (point: { x: number; y: number }) => {
      if (buttonRef.current !== 'none') { clickAt(point); return; }
      const dt = doubleTap.current;
      if (dt && Math.abs(point.x - dt.point.x) < GESTURE.doubleTapSlop && Math.abs(point.y - dt.point.y) < GESTURE.doubleTapSlop) {
        clearTimeout(dt.timer);
        doubleTap.current = null;
        sendLeftClick(dt.point, true); // upgrade the pair to one real double-click
        return;
      }
      if (dt) { clearTimeout(dt.timer); doubleTap.current = null; sendLeftClick(dt.point, false); }
      const timer = setTimeout(() => {
        doubleTap.current = null;
        sendLeftClick(point, false);
      }, GESTURE.doubleTapMs);
      doubleTap.current = { point, timer };
    },
    [clickAt, sendLeftClick]
  );

  /**
   * One throttled wheel send. Deltas are finger px, sign-unchanged — the
   * content follows the finger (scroll-mode.ts says why the sign is shared
   * with the two-finger gesture). Returns the batch so the caller can carry
   * the sub-notch remainder, or null when nothing was worth sending.
   */
  const emitScroll = useCallback(
    (dyPx: number, dxPx: number): ScrollBatch | null => {
      const batch = batchScroll(dyPx, dxPx, GESTURE);
      if (batch.dy === 0 && batch.dx === 0) return null;
      lastScrollAt.current = Date.now();
      send(() => api.scroll(batch.dy, batch.dx), 'Scroll');
      return batch;
    },
    [send]
  );

  /**
   * Scroll-mode momentum: the pan momentum's friction curve, paid out as
   * throttled wheel sends instead of translation. `seed` is whatever the
   * drag still owed below a notch or behind the throttle at release — the
   * trailing send, folded into the flick. Reduced motion flushes the seed
   * and coasts nothing: a flick that scrolls once and stops is broken, but
   * so is motion the user asked not to have.
   */
  const startScrollMomentum = useCallback(
    (vx: number, vy: number, seedX: number, seedY: number) => {
      if (reducedRef.current) {
        emitScroll(seedY, seedX);
        return;
      }
      let px = flickStep(vx, GESTURE);
      let py = flickStep(vy, GESTURE);
      let accX = seedX;
      let accY = seedY;
      const step = (): void => {
        px = decayStep(px, GESTURE);
        py = decayStep(py, GESTURE);
        accX += px;
        accY += py;
        if (scrollDue(Date.now(), lastScrollAt.current, GESTURE)) {
          const batch = emitScroll(accY, accX);
          if (batch) {
            accY = batch.restY;
            accX = batch.restX;
          }
        }
        if (flickSpent(px, py, accX, accY, GESTURE)) {
          scrollMomentum.current = null;
          return;
        }
        scrollMomentum.current = requestAnimationFrame(step);
      };
      scrollMomentum.current = requestAnimationFrame(step);
    },
    [emitScroll]
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
        twoTapEligible: !classified && pairTapEligible(g.kind, g.twoTapEligible),
        touchA: identifierOf(first),
        touchB: identifierOf(second),
        pinchDistance: distance || 1,
        twoStartX: centerX,
        twoStartY: centerY,
        twoLastX: centerX,
        twoLastY: centerY,
        baseScale: view.current.scale,
        scrollX: centerX,
        scrollY: centerY,
        longPress: classified ? g.longPress : undefined,
      };
    },
    [cancelLongPress]
  );

  /**
   * Classifies a two-finger gesture once (pinch.ts owns the rules: pinch
   * zooms anywhere, a plain drag pans when zoomed and scrolls at 1x), then
   * keeps serving that intent.
   */
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
        // Carried as a max ACROSS re-anchors: the anchor resets on a finger
        // swap, and the release's tap-or-not verdict must remember the whole
        // gesture's travel, not just the latest leg's.
        g.twoMovedPx = Math.max(g.twoMovedPx, moved);
        const kind = classifyTwoFinger(ratio, moved, view.current.scale, GESTURE);
        if (kind === 'pendingTwo') return;
        g.kind = kind;
      }

      if (g.kind === 'zoom') {
        // Scale about the fingers, then follow their shared travel. The pinch
        // maths alone is the identity whenever the distance holds, which was
        // the "zoom in but cannot move the focus" bug; the centroid delta is
        // the missing pan, and setTranslate keeps it inside the clamp.
        zoomTo(g.baseScale * ratio, centerX, centerY);
        setTranslate(view.current.tx + centerX - g.twoLastX, view.current.ty + centerY - g.twoLastY);
        g.twoLastX = centerX;
        g.twoLastY = centerY;
        return;
      }
      if (!scrollDue(Date.now(), lastScrollAt.current, GESTURE)) return;
      if (emitScroll(centerY - g.scrollY, centerX - g.scrollX)) {
        g.scrollY = centerY;
        g.scrollX = centerX;
      }
    },
    [emitScroll, rebaselineTwoFingers, setTranslate, zoomTo]
  );

  const handleOneFinger = useCallback(
    (state: PanResponderGestureState) => {
      const g = gesture.current;
      const kind = classifyOneFinger(g.kind, state.dx, state.dy, effectiveMode(), view.current.scale, GESTURE);
      if (kind === 'pending') return;
      if (kind !== g.kind) {
        cancelLongPress();
        g.kind = kind;
      }
      if (g.kind === 'pan') {
        setTranslate(g.baseTx + state.dx, g.baseTy + state.dy);
        return;
      }
      if (g.kind === 'cursor') {
        nudgeCursor(state.dx - g.lastDx, state.dy - g.lastDy);
        g.lastDx = state.dx;
        g.lastDy = state.dy;
        return;
      }
      if (g.kind === 'wheel') {
        // scrollX/scrollY track how much of the responder's cumulative dx/dy
        // has been paid out, so a throttled or sub-notch move is owed to the
        // next send instead of dropped.
        if (!scrollDue(Date.now(), lastScrollAt.current, GESTURE)) return;
        const batch = emitScroll(state.dy - g.scrollY, state.dx - g.scrollX);
        if (batch) {
          g.scrollY = state.dy - batch.restY;
          g.scrollX = state.dx - batch.restX;
        }
      }
    },
    [cancelLongPress, effectiveMode, emitScroll, nudgeCursor, setTranslate]
  );

  /**
   * Follows three fingers by identity until their centroid commits to a
   * direction, then fires exactly once and consumes the gesture: nothing the
   * hand does afterwards — drifting on, dropping to two fingers, adding a
   * fourth — can scroll, zoom or fire again until every finger lifts. A trio
   * broken before committing simply re-anchors, like the pair logic above.
   */
  const handleThreeFingers = useCallback(
    (touches: readonly NativeTouchEvent[], origin: Origin) => {
      const g = gesture.current;
      const trio = g.kind === 'pendingThree' ? trackedTriple(touches, g) : null;
      if (!trio) {
        cancelLongPress();
        const [first, second, third] = touches;
        const center = centroidOf([touchPoint(first, origin), touchPoint(second, origin), touchPoint(third, origin)]);
        gesture.current = {
          ...g,
          kind: 'pendingThree',
          touchA: identifierOf(first),
          touchB: identifierOf(second),
          touchC: identifierOf(third),
          threeStartX: center.x,
          threeStartY: center.y,
          longPress: undefined,
        };
        return;
      }
      const center = centroidOf(trio.map((touch) => touchPoint(touch, origin)));
      const direction = detectSwipe(center.x - g.threeStartX, center.y - g.threeStartY, GESTURE);
      if (!direction) return;
      g.kind = 'consumed';
      haptic('medium');
      onSwipeRef.current?.(direction);
    },
    [cancelLongPress]
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
        // Arms the two-finger tap: the clock runs from THIS touch, so a
        // finger that rested a while before its partner joined cannot tap.
        startAt: Date.now(),
        twoTapEligible: true,
      };
      gesture.current.longPress = setTimeout(() => {
        const g = gesture.current;
        if (g.kind !== 'pending') return;
        g.kind = 'consumed';
        g.longPress = undefined;
        haptic('medium');
        const target = effectiveMode() === 'trackpad' ? cursor.current : toHost(g.startX, g.startY);
        send(() => api.click(target.x, target.y, 'right', false, screenRef.current, activeModsRef.current?.()), 'Right-click');
        onPointerRef.current?.();
      }, GESTURE.longPressMs);
    },
    [effectiveMode, send, stopMomentum, toHost]
  );

  const onRelease = useCallback(
    (event: GestureResponderEvent, state: PanResponderGestureState) => {
      cancelLongPress();
      const g = gesture.current;
      gesture.current = newGesture();
      if (g.kind === 'pending') {
        handleTap(effectiveMode() === 'trackpad' ? cursor.current : toHost(g.startX, g.startY));
        return;
      }
      if (g.kind === 'pendingTwo') {
        // The Mac trackpad's secondary click: two fingers down and up quickly
        // with no real travel. Anything that moved or pinched was classified
        // away from 'pendingTwo' long before this line; anything slow, or a
        // pair formed mid-drag, fails the pure verdict and does nothing —
        // exactly what a released, unclassified pair has always done.
        if (isTwoFingerTap(g.kind, g.twoTapEligible, Date.now() - g.startAt, g.twoMovedPx, GESTURE)) {
          const point = effectiveMode() === 'trackpad' ? cursor.current : toHost(g.twoStartX, g.twoStartY);
          haptic('medium');
          const mods = activeModsRef.current?.();
          send(() => api.click(point.x, point.y, 'right', false, screenRef.current, mods), 'Right-click');
          onPointerRef.current?.();
        }
        return;
      }
      if (g.kind === 'pan') {
        startMomentum(state.vx, state.vy);
        return;
      }
      if (g.kind === 'zoom') {
        // The responder's vx/vy are centroid velocity, so a pinch that ends
        // in a flick coasts exactly like the one-finger pan beside it; at 1x
        // the clamp pins everything to (0,0), so there is nothing to coast.
        if (view.current.scale > 1) startMomentum(state.vx, state.vy);
        return;
      }
      if (g.kind === 'wheel') {
        startScrollMomentum(state.vx, state.vy, state.dx - g.scrollX, state.dy - g.scrollY);
        return;
      }
      if (g.kind === 'hostDrag') {
        const from = toHost(g.startX, g.startY);
        const to = toHost(numberOf(event.nativeEvent.locationX), numberOf(event.nativeEvent.locationY));
        send(() => api.drag(from.x, from.y, to.x, to.y, screenRef.current), 'Drag');
        onPointerRef.current?.();
      }
    },
    [cancelLongPress, clickAt, effectiveMode, handleTap, send, startMomentum, startScrollMomentum, toHost]
  );

  /**
   * One responder recipe, two surfaces. `pad: false` is the stage — the mode
   * the dock chose governs. `pad: true` is the deadspace trackpad: the same
   * gesture vocabulary with the mode pinned to 'trackpad' via `padActive`
   * (set at the grant, read by `effectiveMode` everywhere a gesture asks).
   * Both refuse termination requests, which is what stops a swipe from
   * leaking out to any ancestor pager or navigator mid-gesture.
   */
  const buildResponder = useCallback(
    (pad: boolean): GestureResponderHandlers =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event: GestureResponderEvent) => {
          padActive.current = pad;
          if (pad) onPadInputRef.current?.();
          onGrant(event);
        },
        // Extra fingers landing fire START events, not moves. Adopting the
        // pair/trio here — not only in the move handler — is what lets a
        // perfectly still two-finger tap register at all (no movement means
        // no move events), and it disarms the one-finger long-press the
        // moment a second finger touches rather than a frame later.
        onPanResponderStart: (event: GestureResponderEvent) => {
          const kind = gesture.current.kind;
          if (kind === 'consumed') return;
          const touches = event.nativeEvent.touches;
          const count = touches ? touches.length : 0;
          if (count >= 3 && kind !== 'zoom' && kind !== 'scroll') {
            handleThreeFingers(touches, originOf(event));
            return;
          }
          if (count === 2) handleTwoFingers(touches, originOf(event));
        },
        onPanResponderMove: (event: GestureResponderEvent, state: PanResponderGestureState) => {
          if (pad) onPadInputRef.current?.();
          const kind = gesture.current.kind;
          // A long-press or a fired swipe ends the conversation: whatever the
          // fingers do next must not become a scroll, zoom or second fire.
          if (kind === 'consumed') return;
          const touches = event.nativeEvent.touches;
          const count = touches ? touches.length : 0;
          if (count >= 3 && kind !== 'zoom' && kind !== 'scroll') {
            handleThreeFingers(touches, originOf(event));
            return;
          }
          if (count >= 2) {
            handleTwoFingers(touches, originOf(event));
            return;
          }
          if (kind === 'zoom' || kind === 'scroll' || kind === 'pendingThree') return;
          handleOneFinger(state);
        },
        onPanResponderRelease: (event: GestureResponderEvent, state: PanResponderGestureState) => {
          // Order matters: the release must still see the pad's forced mode.
          onRelease(event, state);
          padActive.current = false;
        },
        onPanResponderTerminate: () => {
          cancelLongPress();
          gesture.current = newGesture();
          padActive.current = false;
        },
      }).panHandlers,
    [cancelLongPress, handleOneFinger, handleThreeFingers, handleTwoFingers, onGrant, onRelease]
  );

  const handlers = useMemo(() => buildResponder(false), [buildResponder]);
  const padHandlers = useMemo(() => buildResponder(true), [buildResponder]);

  // Keep the crosshair pinned when the stage resizes or the zoom changes.
  useEffect(() => {
    paintCursor();
  }, [paintCursor, zoom]);

  useEffect(
    () => () => {
      stopMomentum();
      if (moveTimer.current) clearTimeout(moveTimer.current);
      if (gesture.current.longPress) clearTimeout(gesture.current.longPress);
      if (doubleTap.current) clearTimeout(doubleTap.current.timer);
    },
    [stopMomentum]
  );

  return { translateX, translateY, scale: scaleValue, cursorX, cursorY, zoom, handlers, padHandlers, zoomBy, reset };
}
