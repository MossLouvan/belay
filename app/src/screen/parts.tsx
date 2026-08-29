// Presentational pieces of the remote-screen tab. Every one of them is themed
// through `useTheme()` and reads correctly in both light and dark; the pieces
// that float OVER the live stream use the fixed HUD scrim palette instead
// (see the note on `HUD` below).
//
// Glyphs are view-drawn (2pt bars, borderRadius 1) in the same style as the
// tab-bar icons and the sheet's close glyph — no icon font, no network fetch.

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';
import { Theme, useTheme } from '../theme';
import {
  Badge,
  Banner,
  Button,
  Caption,
  Column,
  Row,
  SegmentedControl,
  Txt,
  haptic,
  useReducedMotion,
  useToggleAnimation,
} from '../ui';
import { KEYS, KeySpec, labelFor, LAUNCHER_NOTE, QualityPreset } from './model';
import { ArrowGlyph, KeyBarCell, buildKeyPages, pageIndexFor } from './keybar';
import { ModsState, StickyMod } from './mods';
import { MonitorChoice } from './monitors';
import { DIMMED_OPACITY, ZOOM_DIM_MS } from './autohide';
import { useAutoHide } from './useAutoHide';
import { Phase, PermissionState, StreamStats } from './stream';
import type { PendingButton, PointerMode } from './viewport';

export const FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

/**
 * Palette for chrome that floats over a live desktop capture. It cannot borrow
 * the theme's `overlay`: that is tuned to sit on a known app surface, and at
 * 0.45 alpha in light mode a white desktop composites to L≈0.294, which drops
 * #F3F6FC to 2.8:1 and the faint ink to 1.9:1 — both failing AA.
 *
 * These values are fixed instead of themed, and chosen for the worst case
 * backdrop (pure white). Composited: 0.86·(6,8,13) + 0.14·(255,255,255) =
 * (40.9,42.6,46.9), L = 0.0238.
 *   #F3F6FC (L 0.9200) -> (0.9200+0.05)/(0.0238+0.05) = 13.1:1
 *   #AEB9CC (L 0.4806) -> (0.4806+0.05)/(0.0238+0.05) =  7.2:1
 * Against a pure black desktop (the other extreme, L = 0.0021) they are 19.0:1
 * and 10.2:1. Every value in between is bounded by these, so both inks clear
 * WCAG AAA for body text over any frame the host can send, in either theme.
 */
export const HUD = Object.freeze({
  scrim: 'rgba(6, 8, 13, 0.86)',
  ink: '#F3F6FC',
  inkDim: '#AEB9CC',
  hairline: 'rgba(243, 246, 252, 0.12)',
});

// --- view-drawn glyphs -------------------------------------------------------
// All built from 2pt bars with borderRadius 1, exactly like `CloseGlyph` in
// ui/sheet.tsx and the tab glyphs in app/(tabs)/_layout.tsx.

const glyphBar = (color: string): ViewStyle => ({
  position: 'absolute',
  backgroundColor: color,
  borderRadius: 1,
});

/** A chevron pointing `direction`, drawn as two 2pt bars meeting at the apex. */
export function ChevronGlyph({ direction, color }: { direction: ArrowGlyph; color: string }) {
  const rotate = { up: '0deg', right: '90deg', down: '180deg', left: '270deg' }[direction];
  return (
    <View style={{ width: 14, height: 14, transform: [{ rotate }] }}>
      <View style={[glyphBar(color), { width: 9, height: 2, left: 0.25, top: 5.75, transform: [{ rotate: '-45deg' }] }]} />
      <View style={[glyphBar(color), { width: 9, height: 2, left: 4.75, top: 5.75, transform: [{ rotate: '45deg' }] }]} />
    </View>
  );
}

/** One L-shaped corner bracket, rotated into place by the fullscreen glyph. */
function Bracket({ left, top, rotate, color }: { left: number; top: number; rotate: string; color: string }) {
  return (
    <View style={{ position: 'absolute', left, top, width: 8, height: 8, transform: [{ rotate }] }}>
      <View style={[glyphBar(color), { top: 0, left: 0, width: 8, height: 2 }]} />
      <View style={[glyphBar(color), { top: 0, left: 0, width: 2, height: 8 }]} />
    </View>
  );
}

/**
 * Four corner brackets: opening outward reads "expand", flipped 180° they all
 * point at the centre and read "collapse" — the standard fullscreen pair.
 */
function FullscreenGlyph({ mode, color }: { mode: 'expand' | 'collapse'; color: string }) {
  const rot = (base: number): string => `${mode === 'expand' ? base : base + 180}deg`;
  return (
    <View style={{ width: 18, height: 18 }}>
      <Bracket left={0} top={0} rotate={rot(0)} color={color} />
      <Bracket left={10} top={0} rotate={rot(90)} color={color} />
      <Bracket left={10} top={10} rotate={rot(180)} color={color} />
      <Bracket left={0} top={10} rotate={rot(270)} color={color} />
    </View>
  );
}

/** Monitor outline with a stand — the tab bar's screen glyph, dock-sized. */
export function MonitorGlyph({ color }: { color: string }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: 18, height: 12, borderRadius: 3, borderWidth: 2, borderColor: color }} />
      <View style={{ width: 8, height: 2, borderRadius: 1, backgroundColor: color, marginTop: 2 }} />
    </View>
  );
}

/** Keyboard outline: a key row and a space bar. */
function KeyboardGlyph({ color }: { color: string }) {
  return (
    <View
      style={{
        width: 20,
        height: 15,
        borderRadius: 3,
        borderWidth: 2,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingBottom: 2,
      }}
    >
      <View style={{ position: 'absolute', top: 3, flexDirection: 'row', gap: 2 }}>
        <View style={{ width: 2, height: 2, borderRadius: 1, backgroundColor: color }} />
        <View style={{ width: 2, height: 2, borderRadius: 1, backgroundColor: color }} />
        <View style={{ width: 2, height: 2, borderRadius: 1, backgroundColor: color }} />
      </View>
      <View style={{ width: 8, height: 2, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

/** Overflow "more" control: three dots. */
export function DotsGlyph({ color }: { color: string }) {
  const dot: ViewStyle = { width: 4, height: 4, borderRadius: 2, backgroundColor: color };
  return (
    <View style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
      <View style={dot} />
      <View style={dot} />
      <View style={dot} />
    </View>
  );
}

/** Mouse outline with the right button filled — the right-click arm. */
function MouseRightGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 13, height: 18, borderRadius: 6, borderWidth: 2, borderColor: color }}>
      <View
        style={{
          position: 'absolute',
          top: 1,
          right: 1,
          width: 4,
          height: 5,
          borderTopRightRadius: 4,
          borderBottomLeftRadius: 1,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function MinusGlyph({ color }: { color: string }) {
  return <View style={{ width: 12, height: 2, borderRadius: 1, backgroundColor: color }} />;
}

function PlusGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 12, height: 12, alignItems: 'center', justifyContent: 'center' }}>
      <View style={[glyphBar(color), { width: 12, height: 2 }]} />
      <View style={[glyphBar(color), { width: 2, height: 12 }]} />
    </View>
  );
}

// --- stage corner (fullscreen toggle) ----------------------------------------

export interface StageCornerProps {
  /** Which glyph to draw: expand enters fullscreen, collapse exits. */
  mode: 'expand' | 'collapse';
  onPress: () => void;
  /**
   * Recede to 35% opacity — the persistent handle while the fullscreen dock is
   * auto-hidden. The parent decides what a press means in that state.
   */
  dimmed?: boolean;
  accessibilityLabel: string;
  /** Positioning (absolute top/right offsets) supplied by the parent. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The fullscreen box anchored in the stage's top-right corner: a proper 44pt
 * target on the HUD scrim, not a little circle.
 */
export function StageCorner({ mode, onPress, dimmed = false, accessibilityLabel, style, testID }: StageCornerProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={theme.layout.hitSlop}
      onPress={() => {
        haptic('light');
        onPress();
      }}
      style={({ pressed }) => [
        {
          position: 'absolute',
          width: theme.layout.minTouch,
          height: theme.layout.minTouch,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: theme.radius.md,
          backgroundColor: HUD.scrim,
          borderWidth: theme.layout.hairline,
          borderColor: HUD.hairline,
          opacity: dimmed ? DIMMED_OPACITY : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <FullscreenGlyph mode={mode} color={HUD.ink} />
    </Pressable>
  );
}

// --- key caps and the paged key bar ------------------------------------------

export interface KeyCapProps {
  spec: KeySpec;
  onPress: (spec: KeySpec) => void;
  mac: boolean;
  /** Draw a chevron instead of the text label (arrow keys). */
  glyph?: ArrowGlyph;
  /** Sticky modifier cap: announces and paints its latch state. */
  sticky?: boolean;
  latched?: boolean;
  locked?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function KeyCap({ spec, onPress, mac, glyph, sticky = false, latched = false, locked = false, style }: KeyCapProps) {
  const theme = useTheme();
  const label = labelFor(spec, mac);
  const background = locked ? theme.colors.accent : latched ? theme.colors.accentSoft : theme.colors.surfaceAlt;
  const ink = locked ? theme.colors.onAccent : latched ? theme.colors.onAccentSoft : theme.colors.text;
  const accessibilityLabel = sticky
    ? `${label} modifier${locked ? ', locked on' : latched ? ', on for the next key' : ''}`
    : `Send ${label}`;
  return (
    <Pressable
      testID={`key-${spec.id}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={sticky ? { selected: latched || locked } : undefined}
      accessibilityHint={sticky ? 'Tap once for the next key, twice quickly to lock' : undefined}
      onPress={() => onPress(spec)}
      style={({ pressed }) => [
        {
          backgroundColor: background,
          borderRadius: theme.radius.sm,
          paddingHorizontal: theme.space.sm,
          minWidth: theme.layout.minTouch,
          minHeight: theme.layout.minTouch,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: theme.layout.hairline,
          borderColor: locked || latched ? theme.colors.accent : theme.colors.borderStrong,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {glyph ? (
        <ChevronGlyph direction={glyph} color={ink} />
      ) : (
        <Txt variant="caption" numberOfLines={1} color={ink} style={{ fontWeight: '700' }}>
          {label}
        </Txt>
      )}
      {locked ? (
        <View style={{ width: 10, height: 2, borderRadius: 1, backgroundColor: ink, marginTop: 2 }} />
      ) : null}
    </Pressable>
  );
}

/** Built once from the model's key list; throws in dev if an id ever drifts. */
const KEY_PAGES = buildKeyPages(KEYS);

export interface KeyBarProps {
  mac: boolean;
  mods: ModsState;
  onKey: (spec: KeySpec) => void;
  onMod: (mod: StickyMod) => void;
  /** Floating over the stream (fullscreen): chrome uses the HUD scrim. */
  floating?: boolean;
  testID?: string;
}

/**
 * KeyBar v2: two rows of 44pt caps, paged horizontally so every key has a
 * fixed, learnable position. Arrows are drawn as chevrons; Ctrl/Alt/Shift/Win
 * are sticky (see mods.ts). Slides up when toggled on; snaps under reduced
 * motion.
 */
export function KeyBar({ mac, mods, onKey, onMod, floating = false, testID }: KeyBarProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: theme.motion.base,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reduced, theme.motion.base]);

  const onLayout = (event: LayoutChangeEvent): void => {
    const next = Math.round(event.nativeEvent.layout.width);
    setWidth((prev) => (prev === next ? prev : next));
  };

  // The pages live inside the container's horizontal padding, so a page (and
  // therefore the snap interval) is the measured width minus both gutters.
  const pageWidth = Math.max(0, width - theme.space.xs * 2);

  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    setPage(pageIndexFor(event.nativeEvent.contentOffset.x, pageWidth, KEY_PAGES.length));
  };

  const cell = (entry: KeyBarCell): React.JSX.Element =>
    entry.kind === 'mod' ? (
      <KeyCap
        key={`mod-${entry.mod}`}
        spec={{ id: entry.label, label: entry.label, key: entry.mod, macLabel: entry.macLabel }}
        mac={mac}
        sticky
        latched={mods.phases[entry.mod] === 'latched'}
        locked={mods.phases[entry.mod] === 'locked'}
        onPress={() => onMod(entry.mod)}
        style={{ flex: 1 }}
      />
    ) : (
      <KeyCap key={entry.spec.id} spec={entry.spec} glyph={entry.glyph} mac={mac} onPress={onKey} style={{ flex: 1 }} />
    );

  return (
    <Animated.View
      testID={testID}
      onLayout={onLayout}
      style={{
        opacity: progress,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        backgroundColor: floating ? HUD.scrim : theme.colors.surface,
        borderRadius: theme.radius.lg,
        borderWidth: theme.layout.hairline,
        borderColor: floating ? HUD.hairline : theme.colors.border,
        paddingVertical: theme.space.xs,
        paddingHorizontal: theme.space.xs,
      }}
    >
      {width > 0 ? (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={settle}
          // Web fires no momentum event; a throttled onScroll keeps the dots honest.
          onScroll={Platform.OS === 'web' ? settle : undefined}
          scrollEventThrottle={64}
          accessibilityLabel={`Keyboard keys, ${KEY_PAGES.length} pages`}
        >
          {KEY_PAGES.map((keyPage, index) => (
            <Column key={index} gap="xs" style={{ width: pageWidth }}>
              <Row gap="xs">{keyPage.top.map(cell)}</Row>
              <Row gap="xs">{keyPage.bottom.map(cell)}</Row>
            </Column>
          ))}
        </ScrollView>
      ) : (
        // Reserve the two-row height so measuring does not jump the layout.
        <View style={{ height: theme.layout.minTouch * 2 + theme.space.xs }} />
      )}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: 'row', alignSelf: 'center', gap: 5, marginTop: theme.space.xs }}
      >
        {KEY_PAGES.map((_, index) => (
          <View
            key={index}
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor:
                index === page ? (floating ? HUD.ink : theme.colors.accent) : floating ? HUD.hairline : theme.colors.borderStrong,
            }}
          />
        ))}
      </View>
    </Animated.View>
  );
}

// --- the control dock ---------------------------------------------------------

interface DockButtonProps {
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress?: () => void;
  active?: boolean;
  floating?: boolean;
  testID?: string;
  accessibilityHint?: string;
  children: React.ReactNode;
}

/** One 44pt control in the dock. Quiet until active, so the bar reads as one piece. */
function DockButton({
  accessibilityLabel,
  onPress,
  onLongPress,
  active = false,
  floating = false,
  testID,
  accessibilityHint,
  children,
}: DockButtonProps) {
  const theme = useTheme();
  // A translucent accent over the dark scrim would sink the ink below AA, so
  // floating active buttons use the opaque accent fill instead.
  const background = active ? (floating ? theme.colors.accent : theme.colors.accentSoft) : 'transparent';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: active }}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        minWidth: theme.layout.minTouch,
        minHeight: theme.layout.minTouch,
        paddingHorizontal: 2,
        borderRadius: theme.radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View accessibilityElementsHidden>{children}</View>
    </Pressable>
  );
}

export interface ControlDockProps {
  mode: PointerMode;
  onModeChange: (mode: PointerMode) => void;
  /** The armed one-shot button override (right-/double-click). */
  armed: PendingButton;
  onToggleRight: () => void;
  onToggleDouble: () => void;
  keysOn: boolean;
  onToggleKeys: () => void;
  typeOpen: boolean;
  onToggleType: () => void;
  screens: readonly MonitorChoice[];
  /** The resolved monitor index currently streamed. */
  selectedScreen: number | undefined;
  onCycleMonitor: () => void;
  onOpenMonitorPicker: () => void;
  /** Floating over the stream (fullscreen): chrome uses the HUD scrim. */
  floating?: boolean;
  /** Fired on every dock interaction — the fullscreen auto-hide's poke. */
  onInteract?: () => void;
}

/**
 * The single control row under (or, fullscreen, over) the stage. Replaces the
 * old four stacked rows: pointer mode + click arms on the left, keyboard /
 * monitor / type on the right. Everything else lives in the header's overflow.
 */
export function ControlDock({
  mode,
  onModeChange,
  armed,
  onToggleRight,
  onToggleDouble,
  keysOn,
  onToggleKeys,
  typeOpen,
  onToggleType,
  screens,
  selectedScreen,
  onCycleMonitor,
  onOpenMonitorPicker,
  floating = false,
  onInteract,
}: ControlDockProps) {
  const theme = useTheme();
  const wrap = (action: () => void) => () => {
    onInteract?.();
    action();
  };
  const ink = (active: boolean): string =>
    active ? (floating ? theme.colors.onAccent : theme.colors.onAccentSoft) : floating ? HUD.ink : theme.colors.text;

  const monitorPosition = screens.findIndex((screen) => screen.index === selectedScreen);
  const monitorShown = (monitorPosition >= 0 ? monitorPosition : 0) + 1;

  return (
    <Row
      testID="control-dock"
      justify="space-between"
      gap="xs"
      style={{
        minHeight: 56,
        paddingHorizontal: theme.space.xs,
        paddingVertical: theme.space.xs - 2,
        borderRadius: theme.radius.lg,
        backgroundColor: floating ? HUD.scrim : theme.colors.surface,
        borderWidth: theme.layout.hairline,
        borderColor: floating ? HUD.hairline : theme.colors.border,
        ...(floating ? {} : theme.elevation.sm),
      }}
    >
      <Row gap="xxs" style={{ flexShrink: 1 }}>
        <SegmentedControl
          testID="pointer-mode"
          accessibilityLabel="Pointer mode"
          value={mode}
          onChange={(next) => {
            onInteract?.();
            onModeChange(next);
          }}
          options={[
            { value: 'touch', label: 'Touch' },
            { value: 'trackpad', label: 'Pad' },
          ]}
          // RN's flexShrink defaults to 0: without these the dock would
          // overflow a 320pt screen once the monitor button appears.
          style={{ width: 124, flexShrink: 1, minWidth: 88 }}
        />
        <DockButton
          testID="right-click"
          accessibilityLabel="Right-click"
          accessibilityHint="Arms the next tap as a right-click"
          active={armed === 'right'}
          floating={floating}
          onPress={wrap(onToggleRight)}
        >
          <MouseRightGlyph color={ink(armed === 'right')} />
        </DockButton>
        <DockButton
          testID="double-click"
          accessibilityLabel="Double-click"
          accessibilityHint="Arms the next tap as a double-click"
          active={armed === 'double'}
          floating={floating}
          onPress={wrap(onToggleDouble)}
        >
          <Txt variant="caption" color={ink(armed === 'double')} style={{ fontWeight: '800' }}>
            2×
          </Txt>
        </DockButton>
      </Row>

      <Row gap="xxs">
        <DockButton
          testID="toggle-keys"
          accessibilityLabel={keysOn ? 'Hide the key bar' : 'Show the key bar'}
          active={keysOn}
          floating={floating}
          onPress={wrap(onToggleKeys)}
        >
          <KeyboardGlyph color={ink(keysOn)} />
        </DockButton>
        {screens.length > 1 ? (
          <DockButton
            testID="monitor-switcher"
            accessibilityLabel={`Monitor ${monitorShown} of ${screens.length}`}
            accessibilityHint="Switches to the next monitor; long press to pick one"
            floating={floating}
            onPress={wrap(onCycleMonitor)}
            onLongPress={wrap(onOpenMonitorPicker)}
          >
            <MonitorGlyph color={ink(false)} />
            <View
              style={{
                position: 'absolute',
                top: -3,
                right: -5,
                minWidth: 15,
                height: 15,
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.accent,
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: 3,
              }}
            >
              <Txt variant="monoSmall" color={theme.colors.onAccent} style={{ fontSize: 9, lineHeight: 11, fontWeight: '700' }}>
                {String(monitorShown)}
              </Txt>
            </View>
          </DockButton>
        ) : null}
        <DockButton
          testID="toggle-type"
          accessibilityLabel={typeOpen ? 'Hide the text field' : 'Type text on the PC'}
          active={typeOpen}
          floating={floating}
          onPress={wrap(onToggleType)}
        >
          <Txt variant="caption" color={ink(typeOpen)} style={{ fontWeight: '800' }}>
            Aa
          </Txt>
        </DockButton>
      </Row>
    </Row>
  );
}

// --- overlays over the stream --------------------------------------------------

export interface StreamHudProps {
  stats: StreamStats;
  pingMs: number | null;
  quality: QualityPreset;
  zoom: number;
}

/** Connection-quality readout. Decorative overlay — never intercepts touches. */
export function StreamHud({ stats, pingMs, quality, zoom }: StreamHudProps) {
  const theme = useTheme();
  const rows: readonly (readonly [string, string])[] = [
    ['fps', `${stats.fps} / ${quality.fps}`],
    ['rate', `${stats.kbps} KB/s`],
    ['frame', `${Math.round(stats.frameBytes / 1024)} KB`],
    ['sent', stats.width > 0 ? `${stats.width}×${stats.height}` : '—'],
    ['source', stats.sourceWidth > 0 ? `${stats.sourceWidth}×${stats.sourceHeight}` : '—'],
    ['ping', pingMs === null ? '—' : `${pingMs} ms`],
    ['zoom', `${zoom.toFixed(1)}×`],
  ];
  return (
    <View
      testID="hud"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        top: theme.space.xs,
        left: theme.space.xs,
        minWidth: 132,
        backgroundColor: HUD.scrim,
        borderRadius: theme.radius.sm,
        borderWidth: theme.layout.hairline,
        borderColor: HUD.hairline,
        paddingHorizontal: theme.space.sm,
        paddingVertical: theme.space.xs,
      }}
    >
      {rows.map(([key, value]) => (
        <Row key={key} gap="xs" justify="space-between">
          <Txt variant="monoSmall" color={HUD.inkDim}>
            {key}
          </Txt>
          <Txt variant="monoSmall" color={HUD.ink}>
            {value}
          </Txt>
        </Row>
      ))}
    </View>
  );
}

/** Trackpad-mode pointer. Lives inside the zoom transform so it tracks the picture. */
export function Crosshair({ x, y, color }: { x: Animated.Value; y: Animated.Value; color: string }) {
  const arm: ViewStyle = { position: 'absolute', backgroundColor: color, borderRadius: 1 };
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: -11,
        left: -11,
        width: 22,
        height: 22,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ translateX: x }, { translateY: y }],
      }}
    >
      <View style={[arm, { width: 22, height: 2 }]} />
      <View style={[arm, { width: 2, height: 22 }]} />
      <View style={{ width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: color }} />
    </Animated.View>
  );
}

export interface ZoomPillProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

/**
 * The zoom controls fused into one pill on the HUD scrim, bottom-right of the
 * stage. Dims to 35% after a couple of idle seconds — still tappable, no
 * longer competing with the desktop — and wakes on any press.
 */
export function ZoomPill({ zoom, onZoomIn, onZoomOut, onReset }: ZoomPillProps) {
  const theme = useTheme();
  const idle = useAutoHide(true, ZOOM_DIM_MS);
  const opacity = useToggleAnimation(idle.visible, theme.motion.fast).interpolate({
    inputRange: [0, 1],
    outputRange: [DIMMED_OPACITY, 1],
  });

  // Pinching changes the zoom without touching the pill; brighten so the
  // readout is legible exactly while it is changing.
  const { poke } = idle;
  useEffect(() => {
    poke();
  }, [poke, zoom]);

  const zone = (
    testID: string,
    accessibilityLabel: string,
    onPress: () => void,
    child: React.ReactNode
  ): React.JSX.Element => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        haptic('selection');
        idle.poke();
        onPress();
      }}
      style={({ pressed }) => ({
        minWidth: theme.layout.minTouch,
        height: theme.layout.minTouch,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {child}
    </Pressable>
  );

  return (
    <View
      pointerEvents="box-none"
      style={{ ...FILL, alignItems: 'flex-end', justifyContent: 'flex-end', padding: theme.space.xs }}
    >
      <Animated.View
        style={{
          flexDirection: 'row',
          borderRadius: theme.radius.pill,
          backgroundColor: HUD.scrim,
          borderWidth: theme.layout.hairline,
          borderColor: HUD.hairline,
          opacity,
        }}
      >
        {zone('zoom-out', 'Zoom out', onZoomOut, <MinusGlyph color={HUD.ink} />)}
        {zone(
          'zoom-level',
          `Zoom ${zoom.toFixed(1)} times. Tap to fit the whole screen.`,
          onReset,
          <Txt variant="monoSmall" color={HUD.ink} style={{ fontWeight: '700' }}>
            {`${zoom.toFixed(1)}×`}
          </Txt>
        )}
        {zone('zoom-in', 'Zoom in', onZoomIn, <PlusGlyph color={HUD.ink} />)}
      </Animated.View>
    </View>
  );
}

// --- stage states and notices ---------------------------------------------------

export interface StageMessageProps {
  phase: Phase;
  attempt: number;
  hostName: string;
}

/** What the stage says before the first frame arrives. */
export function StageMessage({ phase, attempt, hostName }: StageMessageProps) {
  const theme = useTheme();
  const text =
    phase === 'reconnecting'
      ? `Reconnecting to ${hostName} (attempt ${attempt})…`
      : phase === 'error'
        ? 'No picture from the host.'
        : phase === 'idle'
          ? 'Not connected to a host.'
          : 'Waiting for the first frame…';
  return (
    <View
      testID="stage-message"
      pointerEvents="none"
      style={{ ...FILL, alignItems: 'center', justifyContent: 'center', padding: theme.space.md }}
    >
      <Txt variant="caption" tone="faint" align="center">
        {text}
      </Txt>
    </View>
  );
}

export interface NoticeAreaProps {
  permissions: PermissionState;
  phase: Phase;
  attempt: number;
  streamError: string | null;
  actionError: string | null;
  onHelp: () => void;
  onRetry: () => void;
}

/** Banners above the stage: permissions first, then stream faults, then toasts. */
export function NoticeArea({
  permissions,
  phase,
  attempt,
  streamError,
  actionError,
  onHelp,
  onRetry,
}: NoticeAreaProps) {
  const theme = useTheme();
  const showStreamError = streamError !== null && !permissions.captureBlocked;
  if (!permissions.inputBlocked && !showStreamError && !actionError) return null;

  return (
    <Column gap="xs" style={{ paddingHorizontal: theme.space.md, paddingBottom: theme.space.xs }}>
      {permissions.inputBlocked ? (
        <Banner
          testID="accessibility-banner"
          status="warn"
          title="Taps and keys are being ignored"
          message="macOS Accessibility permission is off for the app that launched the host agent, so input injection is blocked."
          action={{ label: 'How to fix', onPress: onHelp }}
        />
      ) : null}
      {showStreamError ? (
        <Banner
          testID="stream-error"
          status="bad"
          title={phase === 'reconnecting' ? `Reconnecting (attempt ${attempt})` : 'Stream problem'}
          message={streamError ?? 'The screen stream stopped.'}
          action={{ label: 'Retry now', onPress: onRetry }}
        />
      ) : null}
      {actionError ? <Banner testID="input-error" status="warn" message={actionError} /> : null}
    </Column>
  );
}

export interface CaptureBlockedProps {
  known: boolean;
  onHelp: () => void;
  onRetry: () => void;
}

/**
 * Full-stage explanation for the black screen a missing macOS Screen Recording
 * grant produces. `box-none` so the stage underneath still takes taps outside
 * the card.
 */
export function CaptureBlocked({ known, onHelp, onRetry }: CaptureBlockedProps) {
  const theme = useTheme();
  return (
    <View
      pointerEvents="box-none"
      style={{ ...FILL, alignItems: 'center', justifyContent: 'center', padding: theme.space.sm }}
    >
      <Column
        testID="permission-blocked"
        gap="xs"
        style={{
          maxWidth: 380,
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.lg,
          borderWidth: theme.layout.hairline,
          borderColor: theme.colors.border,
          padding: theme.space.md,
          ...theme.elevation.lg,
        }}
      >
        <Badge label={known ? 'Screen Recording off' : 'Capture blocked'} status="bad" dot />
        <Txt variant="subheading">macOS is blocking screen capture</Txt>
        <Caption>
          {known
            ? 'The host reports that Screen Recording permission is not granted, so every frame would be black.'
            : 'The host could not capture the display, and the error reads like a macOS privacy refusal.'}
        </Caption>
        <Caption>{LAUNCHER_NOTE}</Caption>
        <Row gap="xs" wrap>
          <Button label="Fix it" onPress={onHelp} size="sm" testID="permission-help" />
          <Button label="Recheck" onPress={onRetry} size="sm" variant="secondary" testID="permission-recheck" />
        </Row>
      </Column>
    </View>
  );
}

/** Shared accessor so the route file does not reach into the theme twice. */
export const statusColorFor = (phase: Phase, theme: Theme): string => {
  if (phase === 'live') return theme.colors.good;
  if (phase === 'error' || phase === 'stalled') return theme.colors.bad;
  return theme.colors.warn;
};
