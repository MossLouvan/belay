// The control bar under (or, when immersive, floating over) the desktop.
//
// Desktop-first IA: with the tab bar gone this is the app's ONE bar, so it
// carries the two things the old layout hid — Keyboard, now one labelled key
// for typing and special keys, and TOOLS, the way
// into Agent/Terminal/Files/System via the drawer. Every control keeps its
// wide-tracked mono label — the discoverability doctrine forbids bare icons
// outside the universal five (docs/DESIGN.md §11.1) — and the active state is
// the accent label plus the 2pt underline, the same selection language as the
// text tabs. Zoom is one key here (tap = fit; pinch the picture to zoom)
// rather than an overlay pill on the video, so nothing tappable hides on top
// of the picture.
//
// TOUCH/PAD/SCROLL are no longer tracked words: on-device testing showed the
// underline trio reads as caption text and the founder could not find the
// mode switch at all. They now render through ModeSwitch (src/screen/
// mode-switch.tsx) — a bordered, full-height segmented strip with the active
// mode solid-filled, so the primary row is unmistakably "the controls".

import type { ScreenMode } from './dock-modes';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { font, getTheme, useTheme } from '../theme';
import { Row, TrackLabel, Txt, Sheet, Button } from '../ui';
import { HUD } from './parts';
import { ModeSwitch } from './mode-switch';
import type { MonitorChoice } from './monitors';
import { recordKeyLabel } from './record';
import { layoutDockKeys } from './dock-layout';
import type { RecordPhase } from './record';
import type { PendingButton } from './viewport';
import { IconPointer, IconKeyboard, IconDeviceGamepad2 } from '@tabler/icons-react-native';

/** VoiceOver's stepper verbs on the zoom key — the old −/+ keys, as gestures. */
const ZOOM_ACTIONS = Object.freeze([
  Object.freeze({ name: 'increment', label: 'Zoom in' }),
  Object.freeze({ name: 'decrement', label: 'Zoom out' }),
]);

interface DockKeyProps {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress?: () => void;
  active?: boolean;
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
      inks={inks}
      align="center"
      hapticTone="selection"
      style={{ minWidth: theme.layout.minTouch, paddingHorizontal: theme.space.xxs }}
    />
  );
}

function DockKeyRows({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const [available, setAvailable] = useState(0);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const keys = React.Children.toArray(children);
  const ids = keys.map((key) => String((key as React.ReactElement).key));
  const widths = ids.map((id) => measured[id]);
  const cells = available > 0 && widths.every((width) => width > 0)
    ? layoutDockKeys(widths, available, theme.space.xs)
    : [];

  return (
    <View onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
      <Row gap="xs" wrap style={{ rowGap: theme.space.xs }}>
        {keys.map((key, index) => (
          <View key={ids[index]} style={{ width: cells[index], alignItems: 'center', flexShrink: 0 }}>
            {/* Measure natural hardware, independently of its allocated cell.
                No width constraint or flex shrink reaches the tracked label;
                font scaling, Rec/Stop/Send and monitor changes remeasure it.
                Keeping one flat keyed tree also preserves press/track state
                when the measured line breaks change. */}
            <View
              style={{ flexDirection: 'row', flexShrink: 0 }}
              onLayout={(event) => {
                const width = Math.ceil(event.nativeEvent.layout.width);
                const id = ids[index];
                setMeasured((previous) => previous[id] === width ? previous : { ...previous, [id]: width });
              }}
            >
              {key}
            </View>
          </View>
        ))}
      </Row>
    </View>
  );
}

export interface ControlDockProps {
  mode: ScreenMode;
  onModeChange: (mode: ScreenMode) => void;
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
  /** Opens the tool drawer (Agent, Terminal, Files, System). */
  onOpenTools: () => void;
  /** Opens the Agent surface directly — the product's real differentiator
   *  gets its own key rather than living only behind Tools. Optional so a
   *  host of the dock that has no agent route stays purely additive. */
  onOpenAgent?: () => void;
  /** Opens the Screen options sheet. Rendered only while floating — in
   *  portrait the header's ⋯ button already owns that job, but the fullscreen
   *  HUD lost its way in when the mascot's tap became the orientation latch. */
  onOpenMenu?: () => void;
  /** Leaves the desktop for the computers list. Rendered only while
   *  floating — in portrait the header's leading ‹ owns that job — and it
   *  replaces the navigator's swipe-back, which is off on this route (it
   *  ran full-width on iOS 26 and swallowed trackpad drags). */
  onBack?: () => void;
  /**
   * Agent sessions blocked on an approval — the Agent key's count chip.
   * (Named for what it counts; it moved off Tools when Agent got a key.)
   */
  agentBadge?: number | null;
}

/**
 * Two labelled banks: pointer mode and zoom on top, the click arms and the
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
  onOpenTools,
  onOpenAgent,
  onOpenMenu,
  onBack,
  agentBadge = null,
}: ControlDockProps) {
  const theme = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);
  // The zoom key shares DockKey's scrim-tuned inks while floating.
  const zoomInks = floating
    ? {
        restLabel: HUD.ink,
        activeLabel: getTheme('dark').colors.accent,
        restTrack: HUD.hairline,
        activeTrack: getTheme('dark').colors.accentGraphic,
      }
    : undefined;
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
      {!floating ? <>
        <View style={{ flexDirection: 'row', borderRadius: 14, padding: 3, backgroundColor: theme.colors.surfaceAlt, borderWidth: 1, borderColor: theme.colors.border }}>
          {[
            { label: 'Trackpad', id: 'dock-trackpad', active: !typeOpen, action: () => { if (typeOpen) onToggleType(); onModeChange('trackpad'); }, glyph: '▱' },
            { label: 'Keyboard', id: 'toggle-type', active: typeOpen, action: onToggleType, glyph: '⌨' },
            { label: 'Controller', id: 'dock-controller', active: false, action: () => onModeChange('gaming'), glyph: '⊕' },
          ].map(item => <Pressable key={item.id} testID={item.id} accessibilityRole="button" accessibilityLabel={item.label}
            accessibilityState={{ selected: item.active }} onPress={wrap(item.action)}
            style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 48, borderRadius: 11, backgroundColor: item.active ? theme.isDark ? theme.colors.accentSoft : theme.colors.accent : 'transparent', opacity: pressed ? 0.6 : 1 })}>
            {React.createElement(item.id === 'dock-trackpad' ? IconPointer : item.id === 'toggle-type' ? IconKeyboard : IconDeviceGamepad2, { size: 20, strokeWidth: 1.7, color: item.active ? theme.isDark ? theme.colors.onAccentSoft : theme.colors.onAccent : theme.colors.textDim })}
            <Txt style={{ fontSize: 12, color: item.active ? theme.isDark ? theme.colors.onAccentSoft : theme.colors.onAccent : theme.colors.text }}>{item.label}</Txt>
          </Pressable>)}
        </View>
        {armed !== 'none' ? <Button label={`Next tap: ${armed}-click · Cancel`} variant="subtle" onPress={armed === 'right' ? onToggleRight : onToggleDouble} /> : null}
        <Pressable testID="more-controls" accessibilityRole="button" accessibilityLabel="More controls" onPress={() => setMoreOpen(true)} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Txt variant="caption" tone="dim">More controls</Txt></Pressable>
      </> : null}
      <Sheet visible={!floating && moreOpen} onClose={() => setMoreOpen(false)} title="More controls" testID="more-controls-sheet">
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ paddingBottom: 16 }}>
        <ModeSwitch mode={mode} onModeChange={(next) => { if (next === 'gaming') setMoreOpen(false); onModeChange(next); }} testID="pointer-mode" />
        <View style={{ gap: 12, marginTop: 16 }}>
          <Button label="Right-click" testID="right-click" onPress={() => { onToggleRight(); setMoreOpen(false); }} variant="secondary" />
          <Button label="Double-click" testID="double-click" onPress={() => { onToggleDouble(); setMoreOpen(false); }} variant="secondary" />
          <Button label={recordKeyLabel(recordPhase)} testID="record-key" onPress={() => { onRecord(); setMoreOpen(false); }} variant="secondary" />
          <Button label={`Zoom ${zoom.toFixed(1)}× · Reset`} testID="zoom-level" onPress={onZoomReset} variant="secondary" />
          {onOpenClipboard ? <Button label="Clipboard" testID="clipboard-key" onPress={() => { setMoreOpen(false); onOpenClipboard(); }} variant="secondary" /> : null}
          {screens.length > 1 ? <Button label={`Monitor ${monitorShown}/${screens.length}`} testID="monitor-switcher" onPress={() => { setMoreOpen(false); onOpenMonitorPicker(); }} variant="secondary" /> : null}
          <Button label="Tools" testID="open-tools" onPress={() => { setMoreOpen(false); onOpenTools(); }} variant="secondary" />
        </View>
        </ScrollView>
      </Sheet>
      {floating ? <>
      <Row justify="space-between" gap="xs" align="center" wrap>
        {/* The mode strip owns the row's slack width: Touch, Pad and Scroll
            answer the same question ("what does one finger do?"), exactly one
            answer holds at a time, and switching between them is THE screen's
            core loop — so it gets the widest, loudest control in the dock. */}
        <ModeSwitch
          testID="pointer-mode"
          mode={mode}
          onModeChange={(next) => {
            onInteract?.();
            onModeChange(next);
          }}
          floating={floating}
          style={{ flex: 1 }}
        />
        {/* ZOOM is one key, not a −/×/+ stepper: two fingers on the picture
            already zoom, and the three-key strip was what starved the mode
            switch until "Scroll" truncated. Tap fits the whole screen; for
            VoiceOver it is an adjustable control, so swipe up/down steps the
            zoom exactly as the old −/+ keys did. */}
        <TrackLabel
          testID="zoom-level"
          label={`${zoom.toFixed(1)}×`}
          accessibilityLabel="Zoom"
          accessibilityHint="Tap to fit the whole screen. Pinch the picture to zoom."
          accessibilityValue={{ text: `${zoom.toFixed(1)} times` }}
          accessibilityActions={ZOOM_ACTIONS}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'increment') wrap(onZoomIn)();
            else if (event.nativeEvent.actionName === 'decrement') wrap(onZoomOut)();
          }}
          inks={zoomInks}
          align="center"
          hapticTone="selection"
          onPress={wrap(onZoomReset)}
          style={{ minWidth: theme.layout.minTouch, paddingHorizontal: theme.space.xxs }}
        />
      </Row>
      {/* Balanced hardware banks: use the fewest lines that fit real label
          widths, balance their key counts, then spread each bank edge to edge.
          This gives 375/390pt docks intentional full lines without hiding
          controls or shrinking Ledger's 11pt tracked words (§11.1). The HUD
          measures inside its scrim padding; larger type can add a bank. */}
      <DockKeyRows>
          {/* BACK leads the row — the corner where every platform parks
              "leave" — as a labelled key like its neighbours, never a bare
              chevron over live video (docs/DESIGN.md §11.1). */}
          {floating && onBack ? (
            <DockKey
              testID="dock-back"
              label={'‹ Back'}
              accessibilityLabel="Back to my computers"
              accessibilityHint="Leaves the desktop for the list of paired computers"
              floating={floating}
              onPress={wrap(onBack)}
            />
          ) : null}
          {/* AGENT leads the second row: Claude on the computer, one key from
              the desktop. The chip is the old Agent tab badge — sessions
              blocked on an approval — moved here from Tools so the count
              sits on the thing it counts. */}
          {onOpenAgent ? (
            <View>
              <DockKey
                testID="dock-agent"
                label="Agent"
                accessibilityLabel={
                  agentBadge !== null && agentBadge > 0
                    ? `Agent — ${agentBadge} waiting for you`
                    : 'Agent'
                }
                accessibilityHint="Opens Claude Code sessions on this computer"
                floating={floating}
                onPress={wrap(onOpenAgent)}
              />
              {agentBadge !== null && agentBadge > 0 ? (
                <View
                  testID="dock-agent-badge"
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: -2,
                    minWidth: 15,
                    maxWidth: 24,
                    height: 15,
                    paddingHorizontal: 3,
                    borderRadius: 2,
                    backgroundColor: theme.colors.accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text
                    allowFontScaling={false}
                    numberOfLines={1}
                    style={{ color: theme.colors.onAccent, fontFamily: font.mono, fontSize: 9 }}
                  >
                    {agentBadge > 99 ? '99+' : String(agentBadge)}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
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
          {onOpenClipboard ? (
            <DockKey
              testID="clipboard-key"
              label="Clipboard"
              accessibilityLabel="Clipboard sync"
              accessibilityHint="Pull the computer's clipboard onto this phone, or send this phone's clipboard to it"
              floating={floating}
              onPress={wrap(onOpenClipboard)}
            />
          ) : null}
          <DockKey
            testID="toggle-type"
            label="Keyboard"
            accessibilityLabel={typeOpen ? 'Hide the keyboard controls' : 'Open the keyboard controls'}
            accessibilityHint="Type text or hold special keys like a regular keyboard"
            active={typeOpen}
            floating={floating}
            onPress={wrap(onToggleType)}
          />
          {floating && onOpenMenu ? (
            <DockKey
              testID="dock-menu"
              label="Menu"
              accessibilityLabel="Screen options"
              accessibilityHint="Stream quality, host audio and help"
              floating={floating}
              onPress={wrap(onOpenMenu)}
            />
          ) : null}
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
          {/* TOOLS — the door to everything that used to be a tab. Bottom-right
              corner, where every platform parks "more"; the drawer it opens
              names and explains Agent, Terminal, Files and System. */}
          <DockKey
            testID="open-tools"
            label="Tools ⋯"
            accessibilityLabel="Tools. Agent, terminal, files and system"
            accessibilityHint="Opens the tool drawer"
            floating={floating}
            onPress={wrap(onOpenTools)}
          />
      </DockKeyRows>
      </> : null}
    </View>
  );
}
