import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { useTheme } from '../theme';
import { Txt, haptic } from '../ui';
import { BUTTONS, NEUTRAL } from './codec';
import type { GamepadState } from './codec';
import { gamepadLayout, stickVector } from './layout';
import type { ControlRect } from './layout';
import type { LayoutChoice, PresetId } from './presets';
import { controlLabel, glyphLayout } from './glyphs';
import type { ControllerLabels } from './glyphs';

// The Move/Look pads sit over the game picture, so they stay translucent
// while the buttons keep full contrast (founder's call: the sticks were
// hiding too much of the screen).
const STICK_OPACITY = 0.45;

function TouchControl({ rect, state, labels }: { readonly rect: ControlRect; readonly state: SharedValue<GamepadState>; readonly labels: ControllerLabels }) {
  const theme = useTheme();
  const stick = rect.id === 'lx' || rect.id === 'rx';
  const trigger = rect.id === 'lt' || rect.id === 'rt';
  const bit = BUTTONS[rect.id as keyof typeof BUTTONS] ?? 0;
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (releaseTimer.current) clearTimeout(releaseTimer.current); }, []);
  const accessibilityPulse = (direction = 1): void => {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    haptic('light');
    state.value = stick ? { ...state.value, [rect.id]: direction } : trigger ? { ...state.value, [rect.id]: 1 } : { ...state.value, buttons: state.value.buttons | bit };
    releaseTimer.current = setTimeout(() => {
      state.value = stick || trigger ? { ...state.value, [rect.id]: 0 } : { ...state.value, buttons: state.value.buttons & ~bit };
    }, 120);
  };
  const pressed = useSharedValue(false);
  const axis = useSharedValue({ x: 0, y: 0 });
  const press = (down: boolean): void => {
    'worklet';
    pressed.value = down;
    state.value = trigger ? { ...state.value, [rect.id]: down ? 1 : 0 } : { ...state.value, buttons: down ? state.value.buttons | bit : state.value.buttons & ~bit };
    if (down) runOnJS(haptic)('light');
  };
  const gesture = stick ? Gesture.Pan().minDistance(0).maxPointers(1)
    .onBegin(() => { pressed.value = true; })
    .onUpdate(event => {
      const v = stickVector(event.translationX, event.translationY, rect.w / 2);
      axis.value = v;
      state.value = rect.id === 'lx' ? { ...state.value, lx: v.x, ly: v.y } : { ...state.value, rx: v.x, ry: v.y };
    })
    .onFinalize(() => {
      pressed.value = false; axis.value = { x: 0, y: 0 };
      state.value = rect.id === 'lx' ? { ...state.value, lx: 0, ly: 0 } : { ...state.value, rx: 0, ry: 0 };
    }) : Gesture.LongPress().minDuration(0).maxDistance(1000).onBegin(() => press(true)).onFinalize(() => press(false));
  const style = useAnimatedStyle(() => ({ borderColor: pressed.value ? theme.colors.accentGraphic : theme.colors.borderStrong }));
  const marker = useAnimatedStyle(() => ({ transform: [{ translateX: axis.value.x * rect.w / 4 }, { translateY: -axis.value.y * (rect.h - theme.layout.minTouch) / 4 }] }));
  const label = controlLabel(rect.id, labels);
  return <GestureDetector gesture={gesture}>
    <Animated.View testID={`gamepad-${rect.id}`} accessible accessibilityRole={stick ? 'adjustable' : 'button'} accessibilityLabel={label}
      onAccessibilityTap={() => accessibilityPulse()}
      accessibilityActions={stick ? [{ name: 'increment', label: 'Right' }, { name: 'decrement', label: 'Left' }] : undefined}
      onAccessibilityAction={event => accessibilityPulse(event.nativeEvent.actionName === 'decrement' ? -1 : 1)}
      style={[{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, backgroundColor: theme.colors.bg, borderWidth: theme.layout.hairline, borderRadius: theme.radius.xs, justifyContent: 'center', opacity: stick ? STICK_OPACITY : 1 }, style]}>
      {/* The cap's word is inert text: the whole pad surface is the gesture
          target and the label is a11y-hidden because the parent announces it.
          It used to be a TrackLabel with a no-op press handler, which painted
          the rope affordance under text nothing can press — exactly what
          ui/track-label.tsx says never to do. */}
      <View style={stick ? { position: 'absolute', top: 0, width: '100%' } : undefined} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Txt variant="label" align="center" tone="dim" numberOfLines={1} style={{ minHeight: theme.layout.minTouch, textAlignVertical: 'center' }}>{label}</Txt>
      </View>
      {stick ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: theme.layout.minTouch + (rect.h - theme.layout.minTouch - theme.space.xs) / 2, alignSelf: 'center', width: theme.space.xs, height: theme.space.xs, backgroundColor: theme.colors.accentGraphic }, marker]} /> : null}
    </Animated.View>
  </GestureDetector>;
}
export function TouchGamepad({ width, height, layout, preset, labels, onState }: { readonly width: number; readonly height: number; readonly layout: LayoutChoice; readonly preset: PresetId; readonly labels: ControllerLabels; readonly onState: (state: GamepadState) => void }) {
  const theme = useTheme();
  const state = useSharedValue<GamepadState>(NEUTRAL);
  useFrameCallback(() => { runOnJS(onState)(state.value); });
  useEffect(() => () => onState(NEUTRAL), [onState]);
  const controls = glyphLayout(gamepadLayout(width, height, layout, preset, theme.layout.minTouch, theme.space.xs), labels, theme.layout.minTouch + theme.space.xl);
  return <GestureHandlerRootView pointerEvents="box-none" style={{ width, height }}>{controls.map(rect => <TouchControl key={rect.id} rect={rect} state={state} labels={labels} />)}</GestureHandlerRootView>;
}
