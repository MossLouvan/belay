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
import { View } from 'react-native';
import { getTheme, useTheme } from '../theme';
import { Row, TrackLabel } from '../ui';
import { HUD } from './parts';
import type { MonitorChoice } from './monitors';
import { recordKeyLabel } from './record';
import type { RecordPhase } from './record';
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
 * One labelled 44pt control, on the shared TrackLabel primitive: quiet mono
 * label over the resting accentDim track, accent + lit track when its state
 * is on — text is the control, exactly as the reference's nav works. The
 * resting track is load-bearing here (docs/DESIGN.md §11.1): without it the
 * dock is two lines of dim mono identical to the status caption above the
 * panel, and the momentary keys (zoom, MON) never signal at all.
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
  // built for paper and fails AA on the near-black HUD, and the resting track
  // drops to the HUD hairline so it stays a quiet mark over live video.
  const ink = getTheme('dark').colors;
  const inks = floating
    ? { restLabel: HUD.ink, activeLabel: ink.accent, restTrack: HUD.hairline, activeTrack: ink.accentGraphic }
    : undefined;

  return (
    <TrackLabel
      testID={testID}
      label={label}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      active={active}
      radio={radio}
      inks={inks}
      align="center"
      hapticTone="selection"
      style={{ minWidth: theme.layout.minTouch, paddingHorizontal: theme.space.xxs }}
    />
  );
}

export interface ControlDockProps {
  mode: PointerMode;
  onModeChange: (mode: PointerMode) => void;
  /** The armed one-shot button override (right-/double-click). */
  armed: PendingButton;
  onToggleRight: () => void;
  onToggleDouble: () => void;
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
  /** Where the host's screen recorder is in its idle → recording → ready loop. */
  recordPhase: RecordPhase;
  /** One key, three meanings: start, stop, or review — recordKeyLabel names each. */
  onRecord: () => void;
  /** Floating over the stream (fullscreen): chrome uses the HUD scrim. */
  floating?: boolean;
  /** Fired on every dock interaction — the fullscreen auto-hide's poke. */
  onInteract?: () => void;
  /** Opens the clipboard sync sheet. Optional so the key is purely additive. */
  onOpenClipboard?: () => void;
  /** Current stream-quality preset label (e.g. "Balanced"), shown on the dock
   *  key so the resolution is visible and one tap away instead of buried in the
   *  overflow menu. Optional so the key stays additive. */
  qualityLabel?: string;
  onOpenQuality?: () => void;
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
  recordPhase,
  onRecord,
  floating = false,
  onInteract,
  onOpenClipboard,
  qualityLabel,
  onOpenQuality,
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
        {/* No gap between TOUCH, PAD and SCROLL: their resting tracks abut
            into one continuous strip, so the trio reads as a three-position
            switch — the segmented control's language, not three stray words.
            Scroll sits here rather than as a separate toggle because all
            three answer the same question, "what does one finger do", and
            exactly one answer can hold at a time. */}
        <View testID="pointer-mode" accessibilityRole="tablist" accessibilityLabel="Pointer mode" style={{ flexDirection: 'row' }}>
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
          <DockKey
            label="Scroll"
            accessibilityLabel="Scroll mode"
            accessibilityHint="Drag one finger to scroll the page; taps still click"
            radio
            active={mode === 'scroll'}
            floating={floating}
            onPress={wrap(() => onModeChange('scroll'))}
          />
        </View>
        <Row gap="xs">
          {qualityLabel && onOpenQuality ? (
            <DockKey
              testID="quality-key"
              label={qualityLabel}
              accessibilityLabel={`Stream quality: ${qualityLabel}`}
              accessibilityHint="Change the streamed resolution and frame rate"
              floating={floating}
              onPress={wrap(onOpenQuality)}
            />
          ) : null}
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
          {/* The label names what pressing does NEXT (Rec → Stop → Send), and
              the lit track holds through recording AND ready — a stopped-but-
              unsent clip must not let the key go quiet. */}
          <DockKey
            testID="record-key"
            label={recordKeyLabel(recordPhase)}
            accessibilityLabel={
              recordPhase === 'recording'
                ? 'Stop recording the screen'
                : recordPhase === 'ready'
                  ? 'Send the recording to Claude'
                  : "Record the computer's screen for Claude"
            }
            accessibilityHint={
              recordPhase === 'idle'
                ? 'Captures frames on the computer to hand to a Claude session'
                : undefined
            }
            active={recordPhase !== 'idle'}
            floating={floating}
            onPress={wrap(onRecord)}
          />
        </Row>
        <Row gap="xs">
          {onOpenClipboard ? (
            <DockKey
              testID="clipboard-key"
              label="Clip"
              accessibilityLabel="Clipboard sync"
              accessibilityHint="Pull the computer's clipboard onto this phone, or send this phone's clipboard to it"
              floating={floating}
              onPress={wrap(onOpenClipboard)}
            />
          ) : null}
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
