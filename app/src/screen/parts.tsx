// Presentational pieces of the remote-screen tab. Every one of them is themed
// through `useTheme()` and reads correctly in both light and dark.

import React from 'react';
import { Animated, Pressable, View, ViewStyle } from 'react-native';
import { Theme, useTheme } from '../theme';
import { Badge, Banner, Button, Caption, Column, Row, Txt, haptic } from '../ui';
import { KeySpec, labelFor, LAUNCHER_NOTE, QualityPreset } from './model';
import { MonitorChoice, monitorLabel } from './monitors';
import { Phase, PermissionState, StreamStats } from './stream';

export const FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

export interface ChipProps {
  label: string;
  onPress: () => void;
  active?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

/** Pill-shaped toggle used across the control deck and the stage overlays. */
export function Chip({ label, onPress, active = false, testID, accessibilityLabel }: ChipProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={theme.layout.hitSlop}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: 38,
        minWidth: 38,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? theme.colors.accent : theme.colors.surfaceAlt,
        borderRadius: theme.radius.pill,
        paddingHorizontal: theme.space.sm + 2,
        borderWidth: theme.layout.hairline,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Txt
        variant="caption"
        numberOfLines={1}
        color={active ? theme.colors.onAccent : theme.colors.text}
        style={{ fontWeight: '700' }}
      >
        {label}
      </Txt>
    </Pressable>
  );
}

export interface KeyCapProps {
  spec: KeySpec;
  onPress: (spec: KeySpec) => void;
  mac: boolean;
}

export function KeyCap({ spec, onPress, mac }: KeyCapProps) {
  const theme = useTheme();
  const label = labelFor(spec, mac);
  return (
    <Pressable
      testID={`key-${spec.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Send ${label}`}
      onPress={() => onPress(spec)}
      style={({ pressed }) => ({
        backgroundColor: theme.colors.surfaceAlt,
        borderRadius: theme.radius.sm,
        paddingHorizontal: 14,
        minWidth: theme.layout.minTouch,
        minHeight: theme.layout.minTouch,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: theme.layout.hairline,
        borderColor: theme.colors.borderStrong,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Txt variant="caption" style={{ fontWeight: '700' }}>
        {label}
      </Txt>
    </Pressable>
  );
}

export interface StreamHudProps {
  stats: StreamStats;
  pingMs: number | null;
  quality: QualityPreset;
  zoom: number;
}

/**
 * The HUD floats over a live desktop capture, so it cannot borrow the theme's
 * `overlay`: that is tuned to sit on a known app surface, and at 0.45 alpha in
 * light mode a white desktop composites to L≈0.294, which drops #F3F6FC to
 * 2.8:1 and the faint ink to 1.9:1 — both failing AA.
 *
 * These three values are fixed instead of themed, and chosen for the worst case
 * backdrop (pure white). Composited: 0.86·(6,8,13) + 0.14·(255,255,255) =
 * (40.9,42.6,46.9), L = 0.0238.
 *   #F3F6FC (L 0.9200) -> (0.9200+0.05)/(0.0238+0.05) = 13.1:1
 *   #AEB9CC (L 0.4806) -> (0.4806+0.05)/(0.0238+0.05) =  7.2:1
 * Against a pure black desktop (the other extreme, L = 0.0021) they are 19.0:1
 * and 10.2:1. Every value in between is bounded by these, so both inks clear
 * WCAG AAA for body text over any frame the host can send, in either theme.
 */
const HUD = Object.freeze({
  scrim: 'rgba(6, 8, 13, 0.86)',
  ink: '#F3F6FC',
  inkDim: '#AEB9CC',
  hairline: 'rgba(243, 246, 252, 0.12)',
});

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

export interface ZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export function ZoomControls({ zoom, onZoomIn, onZoomOut, onReset }: ZoomControlsProps) {
  const theme = useTheme();
  return (
    <View
      pointerEvents="box-none"
      style={{ ...FILL, alignItems: 'flex-end', justifyContent: 'flex-end', padding: theme.space.xs }}
    >
      <Row gap="xs">
        <Chip label="−" onPress={onZoomOut} testID="zoom-out" accessibilityLabel="Zoom out" />
        <Chip
          label={`${zoom.toFixed(1)}×`}
          onPress={onReset}
          testID="zoom-level"
          accessibilityLabel={`Zoom ${zoom.toFixed(1)} times. Tap to fit the whole screen.`}
        />
        <Chip label="+" onPress={onZoomIn} testID="zoom-in" accessibilityLabel="Zoom in" />
      </Row>
    </View>
  );
}

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

export interface MonitorSwitcherProps {
  screens: readonly MonitorChoice[];
  /** The resolved index currently streamed (see resolveScreenIndex). */
  selected: number | undefined;
  onSelect: (index: number) => void;
}

/**
 * Picks which monitor the stage streams — and therefore which monitor every
 * tap lands on; the two are the same index by construction.
 *
 * Renders nothing unless the host reports more than one monitor, so
 * single-monitor users never see it.
 */
// TODO(ui): restyled by the UI redesign pass — deliberately minimal until then.
export function MonitorSwitcher({ screens, selected, onSelect }: MonitorSwitcherProps) {
  if (screens.length < 2) return null;
  return (
    <Row gap="xs" testID="monitor-switcher">
      {screens.map((screen) => (
        <Chip
          key={screen.index}
          label={monitorLabel(screen)}
          active={screen.index === selected}
          onPress={() => onSelect(screen.index)}
          testID={`monitor-${screen.index}`}
          accessibilityLabel={`View monitor ${screen.index + 1}${screen.primary ? ', the main monitor' : ''}`}
        />
      ))}
    </Row>
  );
}

/** Shared accessor so the route file does not reach into the theme twice. */
export const statusColorFor = (phase: Phase, theme: Theme): string => {
  if (phase === 'live') return theme.colors.good;
  if (phase === 'error' || phase === 'stalled') return theme.colors.bad;
  return theme.colors.warn;
};
