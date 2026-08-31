// The control dock under (or, in fullscreen, floating over) the stage.
//
// Ledger restyle of the old glyph row: every control now carries its
// wide-tracked mono label — the discoverability doctrine forbids bare icons
// outside the universal five (docs/DESIGN.md §11.1) — and the active state is
// the accent label plus the 2pt underline, the same selection language as the
// text tabs. The zoom stepper moved here from its overlay pill on the video,
// so nothing tappable hides on top of the picture except the fullscreen
// corner, which acts on the panel itself.
//
// TOUCH/PAD are plain dock keys rather than the shared SegmentedControl: the
// fullscreen dock sits on the fixed HUD scrim, where the themed control's dim
// ink fails contrast in light mode, and the dock keys already carry the
// identical underline treatment.

import React from 'react';
import { Pressable, View } from 'react-native';
import { getTheme, useTheme } from '../theme';
import { Row, Txt, haptic } from '../ui';
import { HUD } from './parts';
import type { MonitorChoice } from './monitors';
import type { PendingButton, PointerMode } from './viewport';

interface DockKeyProps {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress?: () => void;
  active?: boolean;
  /** Radio-style option (TOUCH/PAD) rather than an independent toggle. */
  radio?: boolean;
  floating?: boolean;
  accessibilityHint?: string;
  testID?: string;
}

/**
 * One labelled 44pt control. Quiet mono label, accent + underline when its
 * state is on — text is the control, exactly as the reference's nav works.
 */
function DockKey({
  label,
  accessibilityLabel,
  onPress,
  onLongPress,
  active = false,
  radio = false,
  floating = false,
  accessibilityHint,
  testID,
}: DockKeyProps) {
  const theme = useTheme();
  // Machine-tuned inks for the scrim: the light palette's dim/accent text is
  // built for paper and fails AA on the near-black HUD.
  const ink = getTheme('dark').colors;
  const color = active ? (floating ? ink.accent : theme.colors.accent) : floating ? HUD.ink : theme.colors.textDim;
  const underline = active ? (floating ? ink.accentGraphic : theme.colors.accentGraphic) : 'transparent';

  return (
    <Pressable
      testID={testID}
      accessibilityRole={radio ? 'tab' : 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: active }}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        minHeight: theme.layout.minTouch,
        minWidth: theme.layout.minTouch,
        paddingHorizontal: theme.space.xxs,
        justifyContent: 'center',
        opacity: pressed ? theme.motion.pressOpacity : 1,
      })}
    >
      <Txt variant="label" numberOfLines={1} color={color} align="center">
        {label}
      </Txt>
      <View
        accessibilityElementsHidden
        style={{
          alignSelf: 'stretch',
          height: theme.layout.ruleEmphasis,
          marginTop: theme.space.xxs,
          backgroundColor: underline,
        }}
      />
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
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  /** Floating over the stream (fullscreen): chrome uses the HUD scrim. */
  floating?: boolean;
  /** Fired on every dock interaction — the fullscreen auto-hide's poke. */
  onInteract?: () => void;
}

/**
 * Two labelled rows: pointer mode and zoom on top, the click arms and the
 * lesser toggles below. Everything the screen's core loop needs stays visible
 * without a single gesture or sheet (docs/DESIGN.md §11.2).
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
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  floating = false,
  onInteract,
}: ControlDockProps) {
  const theme = useTheme();
  const wrap = (action: () => void) => () => {
    onInteract?.();
    action();
  };

  const monitorPosition = screens.findIndex((screen) => screen.index === selectedScreen);
  const monitorShown = (monitorPosition >= 0 ? monitorPosition : 0) + 1;

  return (
    <View
      testID="control-dock"
      style={
        floating
          ? {
              backgroundColor: HUD.scrim,
              borderRadius: theme.radius.xs,
              borderWidth: theme.layout.hairline,
              borderColor: HUD.hairline,
              paddingHorizontal: theme.space.xs,
              paddingVertical: theme.space.xxs,
            }
          : undefined
      }
    >
      <Row justify="space-between" gap="xs">
        <View testID="pointer-mode" accessibilityRole="tablist" accessibilityLabel="Pointer mode" style={{ flexDirection: 'row', gap: theme.space.xs }}>
          <DockKey
            label="Touch"
            accessibilityLabel="Touch mode"
            accessibilityHint="Tap where you want to click"
            radio
            active={mode === 'touch'}
            floating={floating}
            onPress={wrap(() => onModeChange('touch'))}
          />
          <DockKey
            label="Pad"
            accessibilityLabel="Trackpad mode"
            accessibilityHint="Drag anywhere to move a visible cursor"
            radio
            active={mode === 'trackpad'}
            floating={floating}
            onPress={wrap(() => onModeChange('trackpad'))}
          />
        </View>
        <Row gap="none">
          <DockKey
            testID="zoom-out"
            label="−"
            accessibilityLabel="Zoom out"
            floating={floating}
            onPress={wrap(onZoomOut)}
          />
          <DockKey
            testID="zoom-level"
            label={`${zoom.toFixed(1)}×`}
            accessibilityLabel={`Zoom ${zoom.toFixed(1)} times. Tap to fit the whole screen.`}
            floating={floating}
            onPress={wrap(onZoomReset)}
          />
          <DockKey
            testID="zoom-in"
            label="+"
            accessibilityLabel="Zoom in"
            floating={floating}
            onPress={wrap(onZoomIn)}
          />
        </Row>
      </Row>
      <Row justify="space-between" gap="xs">
        <Row gap="xs" style={{ flexShrink: 1 }}>
          <DockKey
            testID="right-click"
            label="R-click"
            accessibilityLabel="Right-click"
            accessibilityHint="Arms the next tap as a right-click"
            active={armed === 'right'}
            floating={floating}
            onPress={wrap(onToggleRight)}
          />
          <DockKey
            testID="double-click"
            label="2×click"
            accessibilityLabel="Double-click"
            accessibilityHint="Arms the next tap as a double-click"
            active={armed === 'double'}
            floating={floating}
            onPress={wrap(onToggleDouble)}
          />
        </Row>
        <Row gap="xs">
          <DockKey
            testID="toggle-keys"
            label="Keys"
            accessibilityLabel={keysOn ? 'Hide the key bar' : 'Show the key bar'}
            active={keysOn}
            floating={floating}
            onPress={wrap(onToggleKeys)}
          />
          <DockKey
            testID="toggle-type"
            label="Type"
            accessibilityLabel={typeOpen ? 'Hide the text field' : 'Type text on the PC'}
            active={typeOpen}
            floating={floating}
            onPress={wrap(onToggleType)}
          />
          {screens.length > 1 ? (
            <DockKey
              testID="monitor-switcher"
              label={`Mon ${monitorShown}/${screens.length}`}
              accessibilityLabel={`Monitor ${monitorShown} of ${screens.length}`}
              accessibilityHint="Opens the monitor picker; long press to switch to the next one"
              floating={floating}
              onPress={wrap(onOpenMonitorPicker)}
              onLongPress={wrap(onCycleMonitor)}
            />
          ) : null}
        </Row>
      </Row>
    </View>
  );
}
