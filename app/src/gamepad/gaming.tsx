import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Orientation from 'expo-screen-orientation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Button, Caption, Column, SegmentedControl, Sheet, TrackLabel, Txt } from '../ui';
import { PRESETS, presetOf, layoutChoice } from './presets';
import type { LayoutChoice, PresetId } from './presets';
import { useGamepad } from './use-gamepad';
import { NEUTRAL } from './codec';
import { glyphStyleOf, labelsFor } from './glyphs';
import type { GlyphStyle } from './glyphs';
// Keep the existing app root free of the worklet bridge until touch Gaming is used.
const TouchGamepad = React.lazy(() => import('./touch-gamepad').then(module => ({ default: module.TouchGamepad })));

// Serialize native locks so a fast exit/re-entry cannot restore over the new lock.
let orientationWork: Promise<void> = Promise.resolve();

export function useGaming(active: boolean, connectionKey: string) {
  const [enabled, setEnabled] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [preset, setPreset] = useState<PresetId>('generic');
  const [layout, setLayout] = useState<LayoutChoice>('classic');
  const [glyphStyle, setGlyphStyle] = useState<GlyphStyle>('auto');
  const [loaded, setLoaded] = useState(false);
  const gamepad = useGamepad(active && enabled, preset, connectionKey, () => setEnabled(false), active && (enabled || sheet));
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
        if (previous !== undefined) await Orientation.lockAsync(previous);
      }).catch(() => { });
    };
  }, [enabled, active, gamepad.foreground]);
  return {
    enabled, sheet, preset, layout, glyphStyle, labels, loaded, ...gamepad, setSheet, setPreset, setLayout, setGlyphStyle,
    enter: () => { setSheet(false); setEnabled(true); }, exit: () => { gamepad.updateTouch(NEUTRAL); setEnabled(false); }
  };
}
export type GamingState = ReturnType<typeof useGaming>;
export function GamingSheet({ gaming }: { readonly gaming: GamingState }) {
  const { height } = useWindowDimensions();
  return <Sheet title="Gaming" visible={gaming.sheet} onClose={() => gaming.setSheet(false)} testID="gaming-sheet" style={{ maxHeight: height * 0.9 }}>
    <ScrollView>
    <Column gap="md">
      <Caption>Connect a controller in your device’s Bluetooth settings, or use the touch controls. In a browser, keep this page visible and press a controller button to activate it.</Caption>
      <SegmentedControl accessibilityLabel="Game preset" value={gaming.preset} onChange={gaming.setPreset} options={PRESETS.map(p => ({ value: p.id, label: p.label }))} />
      <Caption>{presetOf(gaming.preset).hint} Xbox passthrough uses the game’s controller bindings.</Caption>
      <SegmentedControl accessibilityLabel="Touch layout" value={gaming.layout} onChange={gaming.setLayout} options={[{ value: 'classic', label: 'Classic' }, { value: 'southpaw', label: 'Southpaw' }]} />
      <SegmentedControl accessibilityLabel="Controller glyph style" value={gaming.glyphStyle} onChange={gaming.setGlyphStyle} options={[{ value: 'auto', label: 'Auto' }, { value: 'playstation', label: 'PlayStation' }]} />
      <Caption>{Object.values(gaming.labels).join(' · ')}</Caption>
      <Caption>With a PlayStation controller, click the touchpad for Select or hold PS for one second to exit Gaming.</Caption>
      <Caption>Gaming locks landscape and uses the fastest supported stream settings. Tap Exit at the top edge to return.</Caption>
      <Button label="Start gaming" onPress={gaming.enter} disabled={!gaming.loaded} />
    </Column>
    </ScrollView>
  </Sheet>;
}
export function GamingOverlay({ gaming, width, height, fps, pingMs }: { readonly gaming: GamingState; readonly width: number; readonly height: number; readonly fps: number; readonly pingMs: number | null }) {
  const theme = useTheme(); const insets = useSafeAreaInsets();
  const w = width - insets.left - insets.right, h = height - insets.top - insets.bottom;
  const touchPreset = gaming.keymap ? gaming.preset : 'generic';
  return <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top, left: insets.left, right: insets.right, bottom: insets.bottom, zIndex: 8 }}>
    {!gaming.physical && gaming.foreground ? <React.Suspense fallback={null}><TouchGamepad key={`${gaming.layout}-${touchPreset}-${w}-${h}`} width={w} height={h} layout={gaming.layout} preset={touchPreset} labels={gaming.labels} onState={gaming.updateTouch} /></React.Suspense> : null}
    <View style={{ position: 'absolute', top: 0, alignSelf: 'center', backgroundColor: theme.colors.bg, paddingHorizontal: theme.space.xs }}>
      <TrackLabel label="Exit" accessibilityLabel="Exit gaming mode" onPress={gaming.exit} align="center" />
      <Txt variant="label">{Math.round(fps)} fps · {pingMs === null ? '—' : Math.round(pingMs)} ms RTT</Txt>
    </View>
    <View pointerEvents="none" style={{ position: 'absolute', bottom: theme.layout.minTouch + theme.space.md, alignSelf: 'center', maxWidth: w / 3, backgroundColor: theme.colors.bg, padding: theme.space.xxs }}>
      <Txt variant="label">{gaming.backend}</Txt>
    </View>
  </View>;
}
