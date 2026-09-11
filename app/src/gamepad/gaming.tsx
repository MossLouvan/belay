import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Orientation from 'expo-screen-orientation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Button, Caption, Column, SegmentedControl, Sheet, Txt } from '../ui';
import { PRESETS, presetOf, layoutChoice } from './presets';
import type { LayoutChoice, PresetId } from './presets';
import { useGamepad } from './use-gamepad';
import { NEUTRAL } from './codec';
import { glyphStyleOf, labelsFor } from './glyphs';
import type { GlyphStyle } from './glyphs';
import { EXIT_HOLD_MS } from './guide';
// Keep the existing app root free of the worklet bridge until touch Gaming is used.
const TouchGamepad = React.lazy(() => import('./touch-gamepad').then(module => ({ default: module.TouchGamepad })));

// Serialize native locks so a fast exit/re-entry cannot restore over the new lock.
let orientationWork: Promise<void> = Promise.resolve();

export function useGaming(active: boolean, connectionKey: string, onExitFullscreen: () => void | Promise<void> = () => {}) {
  const [enabled, setEnabled] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [preset, setPreset] = useState<PresetId>('generic');
  const [layout, setLayout] = useState<LayoutChoice>('classic');
  const [glyphStyle, setGlyphStyle] = useState<GlyphStyle>('auto');
  const [loaded, setLoaded] = useState(false);
  const [exitCount, setExitCount] = useState(0);
  // Set by the screen once its stream hook exists: H.264 open means the
  // controller has a UDP channel to take as well as the WebSocket.
  const [fastPath, setFastPath] = useState(false);
  const exitToPortrait = useRef(false);
  const leaveGaming = useCallback(() => {
    exitToPortrait.current = true;
    setExitCount((count) => count + 1);
    // Serialize the portrait exit behind any in-flight landscape lock. A fast
    // accessibility activation can otherwise let the older lock win last.
    orientationWork = orientationWork.then(() => onExitFullscreen()).catch(() => { });
    setEnabled(false);
  }, [onExitFullscreen]);
  const gamepad = useGamepad(active && enabled, preset, connectionKey, leaveGaming, active && (enabled || sheet), fastPath);
  const labels = labelsFor(gamepad.kind, glyphStyle);
  useEffect(() => {
    let live = true;
    void AsyncStorage.getItem('belay.gamepad.preferences').then(raw => {
      if (!live || !raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Record<string, unknown>; setPreset(presetOf(p.preset).id); setLayout(layoutChoice(p.layout));
        setGlyphStyle(glyphStyleOf(p.glyphStyle));
      }
    }).catch(() => { }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (loaded) void AsyncStorage.setItem('belay.gamepad.preferences', JSON.stringify({ preset, layout, glyphStyle })).catch(() => { }); }, [loaded, preset, layout, glyphStyle]);
  useEffect(() => { if (!active) setEnabled(false); }, [active]);
  useEffect(() => {
    if (!enabled || !active || !gamepad.foreground || Platform.OS === 'web') return;
    Keyboard.dismiss();
    let disposed = false;
    let previous: Orientation.OrientationLock | undefined;
    orientationWork = orientationWork.then(async () => {
      if (disposed) return;
      previous = await Orientation.getOrientationLockAsync();
      if (!disposed) await Orientation.lockAsync(Orientation.OrientationLock.LANDSCAPE);
    }).catch(() => { });
    return () => {
      disposed = true;
      orientationWork = orientationWork.then(async () => {
        if (exitToPortrait.current) exitToPortrait.current = false;
        else if (previous !== undefined) await Orientation.lockAsync(previous);
      }).catch(() => { });
    };
  }, [enabled, active, gamepad.foreground]);
  return {
    enabled, exitCount, sheet, preset, layout, glyphStyle, labels, loaded, ...gamepad, setSheet, setPreset, setLayout, setGlyphStyle, setFastPath,
    enter: () => { exitToPortrait.current = false; setSheet(false); setEnabled(true); },
    exit: () => { gamepad.updateTouch(NEUTRAL); leaveGaming(); }
  };
}
export type GamingState = ReturnType<typeof useGaming>;
export function GamingSheet({ gaming }: { readonly gaming: GamingState }) {
  const { height } = useWindowDimensions();
  return <Sheet title="Gaming" visible={gaming.sheet} onClose={() => gaming.setSheet(false)} testID="gaming-sheet" style={{ maxHeight: height * 0.9 }}>
    <ScrollView>
    <Column gap="md">
      <Caption>Your phone is a controller: use the on-screen sticks, triggers and buttons. A Bluetooth controller is optional.</Caption>
      <SegmentedControl accessibilityLabel="Gaming input" value={gaming.inputMode} onChange={gaming.setInputMode} options={[{ value: 'auto', label: 'Auto' }, { value: 'phone', label: 'Phone' }]} />
      <Caption>{gaming.usingPhysical ? 'Bluetooth controller connected. Auto switches back to your phone if it disconnects.' : 'Phone controls ready. Auto uses a Bluetooth controller when you connect one.'}</Caption>
      {gaming.controllerError ? <Caption>{gaming.controllerError}</Caption> : null}
      <SegmentedControl accessibilityLabel="Game preset" value={gaming.preset} onChange={gaming.setPreset} options={PRESETS.map(p => ({ value: p.id, label: p.label }))} />
      <Caption>{presetOf(gaming.preset).hint} Xbox passthrough uses the game’s controller bindings.</Caption>
      <SegmentedControl accessibilityLabel="Touch layout" value={gaming.layout} onChange={gaming.setLayout} options={[{ value: 'classic', label: 'Classic' }, { value: 'southpaw', label: 'Southpaw' }]} />
      <SegmentedControl accessibilityLabel="Controller glyph style" value={gaming.glyphStyle} onChange={gaming.setGlyphStyle} options={[{ value: 'auto', label: 'Auto' }, { value: 'playstation', label: 'PlayStation' }]} />
      <Caption>{Object.values(gaming.labels).join(' · ')}</Caption>
      <Caption>Gaming uses landscape. To leave, hold the small Exit button at the top of the screen for {EXIT_HOLD_MS / 1000} seconds; it fills as you hold. On a controller, holding PS / Guide does the same. {gaming.labels.start} and {gaming.labels.select} go to the game.</Caption>
      <Button label="Start gaming" onPress={gaming.enter} disabled={!gaming.loaded} />
    </Column>
    </ScrollView>
  </Sheet>;
}
export function GamingOverlay({ gaming, width, height, fps, pingMs }: { readonly gaming: GamingState; readonly width: number; readonly height: number; readonly fps: number; readonly pingMs: number | null }) {
  const theme = useTheme(); const insets = useSafeAreaInsets();
  const w = width - insets.left - insets.right, h = height - insets.top - insets.bottom;
  const touchPreset = gaming.keymap ? gaming.preset : 'generic';
  const exiting = gaming.exitProgress > 0;
  return <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top, left: insets.left, right: insets.right, bottom: insets.bottom, zIndex: 8 }}>
    {!gaming.usingPhysical && gaming.foreground ? <React.Suspense fallback={null}><TouchGamepad key={`${gaming.layout}-${touchPreset}-${w}-${h}`} width={w} height={h} layout={gaming.layout} preset={touchPreset} labels={gaming.labels} onState={gaming.updateTouch} /></React.Suspense> : null}
    {/* The one way off the game from the phone: a small pill at the top
        center (clear of both triggers), held for EXIT_HOLD_MS. Half-faded
        until held; the fill behind the label is the progress. A tap does
        nothing. Start and Back reach the game. */}
    <Pressable testID="gaming-exit" accessibilityRole="button" accessibilityLabel="Exit full screen"
      accessibilityHint="Hold for 1.2 seconds. Release early to cancel."
      onPressIn={() => gaming.setExitPressed(true)} onPressOut={() => gaming.setExitPressed(false)}
      onAccessibilityTap={gaming.exit}
      style={{ position: 'absolute', top: 0, alignSelf: 'center', opacity: exiting ? 1 : 0.5, minHeight: theme.layout.minTouch, minWidth: theme.layout.minTouch, paddingHorizontal: theme.space.sm, borderRadius: theme.radius.xs, backgroundColor: theme.colors.bg, borderWidth: theme.layout.hairline, borderColor: theme.colors.borderStrong, overflow: 'hidden', justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${gaming.exitProgress * 100}%`, backgroundColor: theme.colors.accentGraphic, opacity: 0.35 }} />
      <Txt variant="label">{exiting ? 'Hold…' : 'Exit'}</Txt>
    </Pressable>
    <View pointerEvents="none" style={{ position: 'absolute', bottom: theme.layout.minTouch + theme.space.md, alignSelf: 'center', maxWidth: w / 3, backgroundColor: theme.colors.bg, padding: theme.space.xs, borderRadius: theme.radius.xs }}>
      <Txt variant="label">{gaming.usingPhysical ? 'Bluetooth controller' : 'Phone controller'}</Txt>
      <Txt variant="label">{gaming.backend}</Txt>
      <Txt variant="label">{Math.round(fps)} fps · {pingMs === null ? '—' : Math.round(pingMs)} ms RTT</Txt>
    </View>
  </View>;
}
