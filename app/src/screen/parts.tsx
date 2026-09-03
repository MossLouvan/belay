// Presentational pieces of the remote-screen tab. Every one of them is themed
// through `useTheme()` and reads correctly in both light and dark; the pieces
// that float OVER the live stream use the fixed HUD scrim palette instead
// (see the note on `HUD` below).
//
// Glyphs are view-drawn (2pt bars, borderRadius 1) in the same style as the
// tab-bar icons and the sheet's close glyph — no icon font, no network fetch.
//
// The Ledger migration moved the control dock to ./dock.tsx and replaced the
// stage's message/banner/permission pieces with ./panel-state.tsx — the
// machine panel itself is the empty and error state now (docs/DESIGN.md §9).

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, ScrollView, View } from 'react-native';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { getTheme, useTheme } from '../theme';
import type { Theme } from '../theme';
import { Banner, Column, Micro, Row, Txt, haptic, useReducedMotion } from '../ui';
import { KEYS, labelFor } from './model';
import type { KeySpec, QualityPreset } from './model';
import { buildKeyPages, pageIndexFor } from './keybar';
import type { ArrowGlyph, KeyBarCell } from './keybar';
import { createRepeater } from './repeat';
import type { Repeater } from './repeat';
import { DIMMED_OPACITY } from './autohide';
import type { ModsState, StickyMod } from './mods';
import type { PermissionState, Phase, StreamStats } from './stream';

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
export function FullscreenGlyph({ mode, color }: { mode: 'expand' | 'collapse'; color: string }) {
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

/**
 * Eye glyph for the keys show/hide control: an outline lid with a pupil, and a
 * diagonal slash when the keys are hidden (the standard "hidden" affordance).
 * Paired with a mono label like every other stage control, so it stays within
 * the discoverability doctrine (docs/DESIGN.md §11.1) rather than a bare icon.
 */
export function EyeGlyph({ off, color }: { off: boolean; color: string }) {
  return (
    <View style={{ width: 18, height: 12, alignItems: 'center', justifyContent: 'center' }}>
      {/* lid: an ellipse approximated by a wide rounded box */}
      <View
        style={{
          width: 18,
          height: 11,
          borderRadius: 6,
          borderWidth: 1.5,
          borderColor: color,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* pupil */}
        <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: color }} />
      </View>
      {off ? (
        <View
          style={{
            position: 'absolute',
            width: 22,
            height: 1.5,
            backgroundColor: color,
            transform: [{ rotate: '-45deg' }],
          }}
        />
      ) : null}
    </View>
  );
}

/** Overflow "more" control: three dots — one of the universal five (§11.1). */
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

// --- stage overlay buttons ---------------------------------------------------

export interface StageButtonProps {
  glyph: React.ReactNode;
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  /** Painted like an active toggle when on (accent tint on the label). */
  active?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * One floating control over the stage: a glyph above its mono label, on the HUD
 * scrim. Each button does exactly ONE thing on every press — no press-once-to-
 * reveal, press-again-to-act. Used for the keys (eye) and fullscreen controls.
 */
export function StageButton({ glyph, label, onPress, accessibilityLabel, active = false, style, testID }: StageButtonProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      hitSlop={theme.layout.hitSlop}
      onPress={() => { haptic('light'); onPress(); }}
      style={({ pressed }) => [
        {
          // De-boxed (REVAMP-SPEC §5.6): a low, quiet inline strip on the HUD
          // scrim — no border crate on the picture. Glyph + label sit on one
          // row; the active state is carried by the accent, not a frame.
          minHeight: theme.layout.minTouch,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: theme.space.sm,
          gap: theme.space.xxs,
          borderRadius: theme.radius.xs,
          backgroundColor: HUD.scrim,
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {glyph}
      <Micro style={{ color: active ? getTheme('dark').colors.accent : HUD.ink }}>{label}</Micro>
    </Pressable>
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
 * The fullscreen control. It stays on the panel because it acts on the panel
 * itself, and it carries its mono label — FULL in, EXIT out — because a bare
 * bracket glyph is not one of the universal five (docs/DESIGN.md §11.1).
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
          minWidth: theme.layout.minTouch,
          minHeight: theme.layout.minTouch,
          paddingHorizontal: theme.space.xxs,
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space.xxs,
          borderRadius: theme.radius.xs,
          backgroundColor: HUD.scrim,
          borderWidth: theme.layout.hairline,
          borderColor: HUD.hairline,
          opacity: dimmed ? DIMMED_OPACITY : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <FullscreenGlyph mode={mode} color={HUD.ink} />
      <Micro style={{ color: HUD.inkDim }}>{mode === 'expand' ? 'Full' : 'Exit'}</Micro>
    </Pressable>
  );
}

// --- key caps and the paged key bar ------------------------------------------

export interface KeyCapProps {
  spec: KeySpec;
  onPress: (spec: KeySpec) => unknown;
  /**
   * Sends one auto-repeat of a held key. Distinct from `onPress` because the
   * press does latch bookkeeping and a haptic that must NOT fire eighteen
   * times a second; a repeat is the bare key, on the same modifiers.
   * Omitted, or a spec that is not `repeatable`, leaves the cap tap-only.
   */
  onRepeat?: (spec: KeySpec) => unknown;
  mac: boolean;
  /** Draw a chevron instead of the text label (arrow keys). */
  glyph?: ArrowGlyph;
  /** Sticky modifier cap: announces and paints its latch state. */
  sticky?: boolean;
  latched?: boolean;
  locked?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A recessed `surfaceAlt` key, 4pt corners — the one place that radius is
 * allowed — with an un-bold mono label (bold mono is banned, §12). Only the
 * latch states draw a border; a resting key is a fill, not a box.
 */
export function KeyCap({ spec, onPress, onRepeat, mac, glyph, sticky = false, latched = false, locked = false, style }: KeyCapProps) {
  const theme = useTheme();
  const label = labelFor(spec, mac);
  const repeats = !sticky && spec.repeatable === true && onRepeat !== undefined;

  // Held-key auto-repeat. The repeater is built once and reads its callbacks
  // through a ref, so a re-render mid-hold never swaps the loop out from
  // under a finger that is still down.
  const handlers = useRef({ onPress, onRepeat, spec });
  handlers.current = { onPress, onRepeat, spec };
  // True once press-in has delivered the key, so the trailing onPress does not
  // send it a second time. Left true after release; the next press-in clears it.
  const sentOnPressIn = useRef(false);
  const repeater = useRef<Repeater | null>(null);
  if (repeats && repeater.current === null) {
    repeater.current = createRepeater(() => {
      const current = handlers.current;
      if (!sentOnPressIn.current) {
        sentOnPressIn.current = true;
        return current.onPress(current.spec);
      }
      return current.onRepeat?.(current.spec);
    }, {
      // Wrap the globals so `this` is the global object, not this literal — an
      // unbound window.setTimeout throws "Illegal invocation" on the web build.
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }
  // A cap unmounted mid-hold (page swipe, bar toggled off) must not leave a
  // key repeating into the host.
  useEffect(() => () => repeater.current?.stop(), []);
  const background = locked ? theme.colors.accent : latched ? theme.colors.accentSoft : theme.colors.surfaceAlt;
  const ink = locked ? theme.colors.onAccent : latched ? theme.colors.onAccentSoft : theme.colors.text;
  // Shortcut caps announce what they do, not their glyphs — "Screenshot a
  // region", never "Send ⌘⇧4" (docs/DESIGN.md §11.1: bare glyphs still speak).
  const accessibilityLabel = sticky
    ? `${label} modifier${locked ? ', locked on' : latched ? ', on for the next key' : ''}`
    : spec.action ?? `Send ${label}`;
  return (
    <Pressable
      testID={`key-${spec.id}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={sticky ? { selected: latched || locked } : undefined}
      accessibilityHint={
        sticky ? 'Tap once for the next key, twice quickly to lock' : repeats ? 'Hold to repeat' : undefined
      }
      onPress={() => {
        // VoiceOver activation fires onPress without a press-in, so the tap
        // path stays live; a finger press has already sent it.
        if (sentOnPressIn.current) return;
        onPress(spec);
      }}
      onPressIn={
        repeats
          ? () => {
              sentOnPressIn.current = false;
              repeater.current?.start();
            }
          : undefined
      }
      onPressOut={repeats ? () => repeater.current?.stop() : undefined}
      style={({ pressed }) => [
        {
          backgroundColor: background,
          borderRadius: theme.radius.sm,
          paddingHorizontal: theme.space.sm,
          minWidth: theme.layout.minTouch,
          minHeight: theme.layout.minTouch,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: locked || latched ? theme.layout.hairline : 0,
          borderColor: theme.colors.accent,
          opacity: pressed ? theme.motion.pressOpacity : 1,
        },
        style,
      ]}
    >
      {glyph ? (
        <ChevronGlyph direction={glyph} color={ink} />
      ) : (
        <Txt variant="mono" numberOfLines={1} color={ink}>
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
  onKey: (spec: KeySpec) => unknown;
  /** One auto-repeat of a held key — see KeyCapProps.onRepeat. */
  onRepeat?: (spec: KeySpec) => unknown;
  onMod: (mod: StickyMod) => void;
  /** Floating over the stream (fullscreen): chrome uses the HUD scrim. */
  floating?: boolean;
  testID?: string;
}

/**
 * KeyBar v2: two rows of 44pt caps, paged horizontally so every key has a
 * fixed, learnable position. Arrows are drawn as chevrons; Ctrl/Alt/Shift/Win
 * are sticky (see mods.ts). Slides up when toggled on; snaps under reduced
 * motion. Sits bare on the page — the keys themselves are the recessed fills,
 * the bar has no box of its own outside the fullscreen scrim.
 */
export function KeyBar({ mac, mods, onKey, onRepeat, onMod, floating = false, testID }: KeyBarProps) {
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
      <KeyCap
        key={entry.spec.id}
        spec={entry.spec}
        glyph={entry.glyph}
        mac={mac}
        onPress={onKey}
        onRepeat={onRepeat}
        style={{ flex: 1 }}
      />
    );

  return (
    <Animated.View
      testID={testID}
      onLayout={onLayout}
      style={{
        opacity: progress,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        backgroundColor: floating ? HUD.scrim : 'transparent',
        borderRadius: floating ? theme.radius.xs : 0,
        borderWidth: floating ? theme.layout.hairline : 0,
        borderColor: HUD.hairline,
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
                index === page
                  ? floating
                    ? HUD.ink
                    : theme.colors.accentGraphic
                  : floating
                    ? HUD.hairline
                    : theme.colors.borderStrong,
            }}
          />
        ))}
      </View>
    </Animated.View>
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
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ pointerEvents: 'none',
        position: 'absolute',
        top: theme.space.xs,
        left: theme.space.xs,
        minWidth: 132,
        backgroundColor: HUD.scrim,
        borderRadius: theme.radius.xs,
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
      style={{ pointerEvents: 'none',
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

// --- notices -----------------------------------------------------------------

export interface NoticeAreaProps {
  permissions: PermissionState;
  actionError: string | null;
  onHelp: () => void;
}

/**
 * Input-side notices only. Stream faults and capture blocks moved INTO the
 * machine panel (panel-state.tsx) — this survives for the two problems the
 * panel cannot show while a live picture fills it: blocked input injection,
 * and one-shot input failures.
 */
export function NoticeArea({ permissions, actionError, onHelp }: NoticeAreaProps) {
  const theme = useTheme();
  if (!permissions.inputBlocked && !actionError) return null;

  return (
    <Column gap="xs" style={{ paddingHorizontal: theme.layout.margin, paddingBottom: theme.space.xs }}>
      {permissions.inputBlocked ? (
        <Banner
          testID="accessibility-banner"
          status="warn"
          title="Taps and keys are being ignored"
          message="macOS Accessibility permission is off for the app that launched the host agent, so input injection is blocked."
          action={{ label: 'How to fix', onPress: onHelp }}
        />
      ) : null}
      {actionError ? <Banner testID="input-error" status="warn" message={actionError} /> : null}
    </Column>
  );
}

/** Shared accessor so the route file does not reach into the theme twice. */
export const statusColorFor = (phase: Phase, theme: Theme): string => {
  if (phase === 'live') return theme.colors.good;
  if (phase === 'error' || phase === 'stalled') return theme.colors.bad;
  return theme.colors.warn;
};
