// Remote screen — the flagship surface.
//
// Streams JPEG frames from the host over a WebSocket into a zoomable, pannable
// stage. Two pointer models are offered: direct touch (tap where you want to
// click) and trackpad (drag anywhere to nudge a visible cursor), because hitting
// a 12px checkbox on a 1710x1107 desktop from a phone is otherwise guesswork.
//
// Ledger layout (docs/DESIGN.md §9): header block, full-bleed hairline, then
// the machine panel — true-dark in both themes, top-aligned, filling all space
// down to the labelled control dock. While there is no picture the panel's
// interior IS the empty/error state (src/screen/panel-state.tsx); the old
// stranded black box and its separate red banner are gone.
//
// The socket, the gesture model and the presentational pieces live in
// `src/screen/*` — sibling files inside `app/(tabs)/` are picked up by
// expo-router's route context and would register as extra tabs.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useIsFocused, useNavigation } from 'expo-router';
import { useConnection } from '../../src/connection';
import { api } from '../../src/api';
import { useTheme } from '../../src/theme';
import {
  Button,
  Caption,
  Column,
  Dot,
  IconButton,
  Input,
  ListItem,
  Row,
  Rule,
  SegmentedControl,
  Sheet,
  Txt,
  haptic,
  useReducedMotion,
  useToggleAnimation,
} from '../../src/ui';
import {
  DEFAULT_QUALITY,
  EMPTY_SIZE,
  fitBox,
  findQuality,
  GESTURE,
  keyFor,
  LAUNCHER_NOTE,
  MAC_STEPS,
  messageOf,
  modsFor,
  QUALITY,
  STREAM,
} from '../../src/screen/model';
import type { KeySpec, QualityId, Size } from '../../src/screen/model';
import {
  aspectOf,
  isMacHost,
  PHASE_LABEL,
  readPermissions,
  useHostFacts,
  useScreenStream,
} from '../../src/screen/stream';
import { useViewport } from '../../src/screen/viewport';
import type { PendingButton, PointerMode } from '../../src/screen/viewport';
import { monitorLabel, nextScreenIndex, resolveScreenIndex, screensOf } from '../../src/screen/monitors';
import {
  IDLE_MODS,
  activeMods,
  modNamesForHost,
  releaseLatched,
  tapMod,
} from '../../src/screen/mods';
import type { ModsState, StickyMod } from '../../src/screen/mods';
import { useAutoHide } from '../../src/screen/useAutoHide';
import {
  Crosshair,
  DotsGlyph,
  KeyBar,
  NoticeArea,
  StageCorner,
  statusColorFor,
  StreamHud,
} from '../../src/screen/parts';
import { ControlDock } from '../../src/screen/dock';
import { PanelState } from '../../src/screen/panel-state';

export default function ScreenTab() {
  const { connection } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const navigation = useNavigation();

  const [qualityId, setQualityId] = useState<QualityId>(DEFAULT_QUALITY);
  const [mode, setMode] = useState<PointerMode>('touch');
  const [button, setButton] = useState<PendingButton>('none');
  const [fullscreen, setFullscreen] = useState(false);
  const [keysOn, setKeysOn] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [mods, setMods] = useState<ModsState>(IDLE_MODS);
  const [showHud, setShowHud] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showMonitorPicker, setShowMonitorPicker] = useState(false);
  const [text, setText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [box, setBox] = useState<Size>(EMPTY_SIZE);

  const quality = useMemo(() => findQuality(qualityId), [qualityId]);

  // The latch state, mirrored into a ref so `sendKey` reads the value at press
  // time without rebuilding its callback on every latch change.
  const modsRef = useRef(mods);
  modsRef.current = mods;

  // The tab navigator keeps every visited route mounted, so `connection` alone
  // would leave the frame socket, the 15s info poll and the per-second stats
  // ticker running while the user works in Terminal or Files. Gating on focus
  // as well releases all three the moment the tab goes off screen.
  const focused = useIsFocused();
  const active = Boolean(connection) && focused;
  const facts = useHostFacts(active);

  // Which monitor the stream shows AND every input call targets — one value,
  // by construction, because the host maps normalized coordinates onto the
  // captured monitor's rectangle. `selectedScreen` remembers the user's tap;
  // `screenIndex` re-validates it against the live monitor list every poll
  // (undefined until the host reports a list, so old hosts get no index at
  // all and keep their primary-monitor behavior).
  const screens = useMemo(() => screensOf(facts.info), [facts.info]);
  const [selectedScreen, setSelectedScreen] = useState<number | undefined>(undefined);
  const screenIndex = useMemo(
    () => resolveScreenIndex(selectedScreen, screens),
    [selectedScreen, screens]
  );

  const stream = useScreenStream(active, quality, screenIndex);

  const permissions = useMemo(() => readPermissions(facts.info, stream.error), [facts.info, stream.error]);
  const isMac = isMacHost(facts.info);

  // The stage is sized to the remote aspect ratio so the picture fills it
  // exactly: no letterboxing means touch coordinates map straight through.
  const aspect = useMemo(() => aspectOf(stream.stats, facts.info), [facts.info, stream.stats]);
  const stage = useMemo(() => fitBox(box, aspect), [box, aspect]);
  const stageRef = useRef<Size>(EMPTY_SIZE);
  stageRef.current = stage;

  // Immersive fullscreen hides the tab bar for the whole navigator, so both
  // exits — the corner press AND unmount (navigating away however it happens)
  // — must put it back or every other tab loses its navigation.
  useEffect(() => {
    navigation.setOptions({ tabBarStyle: fullscreen ? { display: 'none' } : undefined });
  }, [navigation, fullscreen]);
  useEffect(
    () => () => {
      navigation.setOptions({ tabBarStyle: undefined });
    },
    [navigation]
  );

  // In fullscreen the floating dock hides after 4s untouched; while the text
  // field is open it stays put (the keyboard is up — hiding under the user's
  // thumbs would be hostile). Stage touches never poke this: they are remote
  // input, and the only reveal is the dimmed corner handle.
  const dockHide = useAutoHide(fullscreen && !typeOpen);
  const dockShown = !fullscreen || dockHide.visible;
  const dockOpacity = useToggleAnimation(dockShown, theme.motion.fast);

  // Transient toast for one-shot input failures. Timer cleared on unmount.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reportError = useCallback((message: string) => {
    setActionError(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setActionError(null), STREAM.toastMs);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  const clearButton = useCallback(() => setButton('none'), []);
  // A pointer action on the stage spends one-shot latched modifiers, the same
  // way letting go of Ctrl does when you reach for the mouse. (The host's
  // /input/click does not take modifiers, so the latch cannot ride along on a
  // click — it applies to the next KEY; the tap just abandons it.)
  const spendLatch = useCallback(() => setMods(releaseLatched), []);
  const viewport = useViewport({
    sizeRef: stageRef,
    mode,
    button,
    onButtonUsed: clearButton,
    onError: reportError,
    reducedMotion,
    inputBlocked: permissions.inputBlocked,
    screen: screenIndex,
    onPointer: spendLatch,
    activeMods: () => modNamesForHost(activeMods(modsRef.current), isMac),
  });

  const onBoxLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  const sendKey = useCallback(
    (spec: KeySpec) => {
      haptic('light');
      const base = modsFor(spec, isMac);
      const latched = modNamesForHost(activeMods(modsRef.current), isMac).filter((m) => !base.includes(m));
      setMods(releaseLatched);
      api
        .key(keyFor(spec, isMac), [...latched, ...base])
        .catch((e: unknown) => reportError(`Key ${spec.id} failed — ${messageOf(e)}`));
    },
    [isMac, reportError]
  );

  const tapModifier = useCallback((mod: StickyMod) => {
    haptic('selection');
    setMods((state) => tapMod(state, mod, Date.now()));
  }, []);

  const sendText = useCallback(() => {
    const value = text.trim();
    if (!value) return;
    haptic('light');
    setText('');
    api.typeText(value).catch((e: unknown) => reportError(`Sending text failed — ${messageOf(e)}`));
  }, [reportError, text]);

  const recheck = useCallback(() => {
    facts.refresh();
    stream.retry();
  }, [facts, stream]);

  const cycleMonitor = useCallback(() => {
    const next = nextScreenIndex(screenIndex, screens);
    if (next !== undefined) setSelectedScreen(next);
  }, [screenIndex, screens]);

  // The corner control: enter fullscreen from the normal layout; in fullscreen
  // it exits — unless the dock has auto-hidden, in which case the dimmed
  // handle's job is to bring the controls back first.
  const onCornerPress = useCallback(() => {
    if (!fullscreen) {
      setFullscreen(true);
      return;
    }
    if (!dockHide.visible) {
      dockHide.poke();
      return;
    }
    setFullscreen(false);
  }, [fullscreen, dockHide]);

  const live = stream.phase === 'live';
  const connecting = stream.phase === 'connecting' || stream.phase === 'reconnecting';
  const showPanelState = permissions.captureBlocked || !stream.frameUri;

  const noticeArea = <NoticeArea permissions={permissions} actionError={actionError} onHelp={() => setShowHelp(true)} />;

  const typeRow = (
    <Row gap="sm">
      <Input
        testID="type-input"
        style={{ flex: 1 }}
        value={text}
        onChangeText={setText}
        placeholder="Type text to send to the PC…"
        accessibilityLabel="Text to type on the host"
        returnKeyType="send"
        onSubmitEditing={sendText}
        autoFocus
      />
      <Button testID="send-text" label="Send" onPress={sendText} size="sm" />
    </Row>
  );

  const controls = (
    <Column gap="xs">
      {keysOn ? (
        <KeyBar mac={isMac} mods={mods} onKey={sendKey} onMod={tapModifier} floating={fullscreen} testID="key-bar" />
      ) : null}
      {typeOpen ? typeRow : null}
      <ControlDock
        mode={mode}
        onModeChange={setMode}
        armed={button}
        onToggleRight={() => setButton((b) => (b === 'right' ? 'none' : 'right'))}
        onToggleDouble={() => setButton((b) => (b === 'double' ? 'none' : 'double'))}
        keysOn={keysOn}
        onToggleKeys={() => setKeysOn((v) => !v)}
        typeOpen={typeOpen}
        onToggleType={() => setTypeOpen((v) => !v)}
        screens={screens}
        selectedScreen={screenIndex}
        onCycleMonitor={cycleMonitor}
        onOpenMonitorPicker={() => setShowMonitorPicker(true)}
        zoom={viewport.zoom}
        onZoomIn={() => viewport.zoomBy(GESTURE.zoomStep)}
        onZoomOut={() => viewport.zoomBy(1 / GESTURE.zoomStep)}
        onZoomReset={viewport.reset}
        floating={fullscreen}
        onInteract={fullscreen ? dockHide.poke : undefined}
      />
    </Column>
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{
        flex: 1,
        backgroundColor: fullscreen ? theme.colors.machine : theme.colors.bg,
        paddingTop: fullscreen ? 0 : insets.top,
      }}
    >
      {/* Mounted only in fullscreen: RN's status bar restores the previous
          entry when this unmounts, so the root layout's style survives. */}
      {fullscreen ? <StatusBar hidden /> : null}

      {!fullscreen ? (
        <View style={{ paddingHorizontal: theme.layout.margin, paddingTop: theme.space.md, paddingBottom: theme.space.md }}>
          <Row justify="space-between" gap="sm">
            <Txt variant="title" heading numberOfLines={1} style={{ flexShrink: 1 }}>
              {connection?.hostName || 'Screen'}
            </Txt>
            <IconButton
              testID="screen-menu"
              accessibilityLabel="Screen options"
              variant="plain"
              onPress={() => setShowMenu(true)}
            >
              <DotsGlyph color={theme.colors.textDim} />
            </IconButton>
          </Row>
          <Row gap="xs" style={{ marginTop: theme.space.xxs }}>
            <Dot color={statusColorFor(stream.phase, theme)} pulse={connecting || live} label={PHASE_LABEL[stream.phase]} />
            <Txt testID="fps" variant="label" tone="dim">
              {live ? `${PHASE_LABEL[stream.phase]} · ${stream.stats.fps} fps` : PHASE_LABEL[stream.phase]}
            </Txt>
          </Row>
        </View>
      ) : null}

      {!fullscreen ? noticeArea : null}
      {!fullscreen ? <Rule /> : null}

      {/* The machine panel: full-bleed, top-aligned under the header rule,
          filling everything down to the dock so the page never jumps between
          the live, waiting and failed states (docs/DESIGN.md §9). */}
      <View
        onLayout={onBoxLayout}
        style={{
          flex: 1,
          backgroundColor: theme.colors.machine,
          alignItems: 'center',
          justifyContent: fullscreen ? 'center' : 'flex-start',
        }}
      >
        <View
          testID="screen-surface"
          accessibilityLabel="Remote screen. Tap to click, long press to right-click, pinch to zoom, two fingers to scroll."
          {...viewport.handlers}
          style={{
            width: stage.w > 0 ? stage.w : '100%',
            height: stage.h > 0 ? stage.h : undefined,
            aspectRatio: stage.h > 0 ? undefined : aspect,
            backgroundColor: theme.colors.machine,
            overflow: 'hidden',
          }}
        >
          {/* pointerEvents none on everything inside keeps `screen-surface`
              the only touch target, so locationX/Y stay in stage coordinates
              on both native and web regardless of the zoom transform. */}
          <Animated.View
            pointerEvents="none"
            style={{
              width: '100%',
              height: '100%',
              transform: [
                { translateX: viewport.translateX },
                { translateY: viewport.translateY },
                { scale: viewport.scale },
              ],
            }}
          >
            {stream.frameUri ? (
              <Image
                source={{ uri: stream.frameUri }}
                accessibilityIgnoresInvertColors
                style={{ width: '100%', height: '100%' }}
                resizeMode="cover"
              />
            ) : null}
            {mode === 'trackpad' && stream.frameUri ? (
              <Crosshair x={viewport.cursorX} y={viewport.cursorY} color={theme.colors.accent} />
            ) : null}
          </Animated.View>

          {showHud ? (
            <StreamHud stats={stream.stats} pingMs={facts.pingMs} quality={quality} zoom={viewport.zoom} />
          ) : null}

          {/* Normal mode: the labelled FULL control rides the stage's own
              top-right corner — it acts on the panel, so it stays on it. */}
          {!fullscreen && !permissions.captureBlocked ? (
            <StageCorner
              mode="expand"
              onPress={onCornerPress}
              accessibilityLabel="Enter full screen"
              testID="stage-corner"
              style={{ top: theme.space.xs, right: theme.space.xs }}
            />
          ) : null}
        </View>

        {/* No picture: the panel interior becomes the guidance surface —
            state name, the observed cause, one accent action, proof of life.
            It covers the stage, which has nothing to click anyway. */}
        {showPanelState ? (
          <PanelState
            testID="panel-state"
            connected={Boolean(connection)}
            phase={stream.phase}
            attempt={stream.attempt}
            streamError={stream.error}
            captureBlocked={permissions.captureBlocked}
            captureKnown={permissions.known}
            hostName={connection?.hostName || 'The computer'}
            onRetry={recheck}
            onHelp={() => setShowHelp(true)}
          />
        ) : null}

        {/* Fullscreen: the corner pins to the safe area, not the (letterboxed)
            stage, so it is always exactly where the thumb expects it. Dimmed
            while the dock is hidden — then its press reveals rather than exits. */}
        {fullscreen ? (
          <StageCorner
            mode="collapse"
            dimmed={!dockHide.visible}
            onPress={onCornerPress}
            accessibilityLabel={dockHide.visible ? 'Exit full screen' : 'Show the controls'}
            testID="stage-corner"
            style={{ top: insets.top + theme.space.xs, right: insets.right + theme.space.xs }}
          />
        ) : null}

        {/* Input errors still matter in fullscreen; they float over the top edge. */}
        {fullscreen ? (
          <View
            pointerEvents="box-none"
            style={{ position: 'absolute', top: insets.top + theme.space.xs, left: 0, right: 0 }}
          >
            {noticeArea}
          </View>
        ) : null}
      </View>

      {!fullscreen ? (
        <View style={{ paddingHorizontal: theme.layout.margin }}>
          <Rule bleed={theme.layout.margin} />
          <View style={{ paddingTop: theme.space.xs, paddingBottom: insets.bottom + theme.space.sm }}>{controls}</View>
        </View>
      ) : (
        <Animated.View
          pointerEvents={dockShown ? 'box-none' : 'none'}
          style={{
            position: 'absolute',
            left: insets.left + theme.space.sm,
            right: insets.right + theme.space.sm,
            bottom: insets.bottom + theme.space.sm,
            opacity: dockOpacity,
          }}
        >
          {controls}
        </Animated.View>
      )}

      <Sheet visible={showMenu} onClose={() => setShowMenu(false)} title="Screen options" testID="screen-menu-sheet">
        <Column gap="xxs">
          <ListItem
            testID="quality"
            title="Stream quality"
            subtitle={quality.label}
            onPress={() => {
              setShowMenu(false);
              setShowQuality(true);
            }}
          />
          <ListItem
            testID="toggle-hud"
            title="Connection HUD"
            subtitle={showHud ? 'Shown over the stream' : 'Hidden'}
            selected={showHud}
            accessibilityHint="Toggles the fps, bitrate and ping overlay"
            onPress={() => setShowHud((v) => !v)}
          />
          <ListItem
            testID="screen-help"
            title="Controls & permissions"
            subtitle="Gestures, right-click, macOS grants"
            onPress={() => {
              setShowMenu(false);
              setShowHelp(true);
            }}
          />
        </Column>
      </Sheet>

      <Sheet
        visible={showMonitorPicker}
        onClose={() => setShowMonitorPicker(false)}
        title="Monitor"
        testID="monitor-sheet"
      >
        <Column gap="xxs">
          {screens.map((screen) => (
            <ListItem
              key={screen.index}
              testID={`monitor-${screen.index}`}
              title={`Monitor ${monitorLabel(screen)}`}
              subtitle={screen.w > 0 ? `${screen.w}×${screen.h}` : undefined}
              selected={screen.index === screenIndex}
              onPress={() => {
                setSelectedScreen(screen.index);
                setShowMonitorPicker(false);
              }}
            />
          ))}
        </Column>
      </Sheet>

      <Sheet visible={showQuality} onClose={() => setShowQuality(false)} title="Stream quality" testID="quality-sheet">
        <Column gap="sm">
          <SegmentedControl
            testID="quality-options"
            accessibilityLabel="Stream quality"
            value={qualityId}
            onChange={setQualityId}
            options={QUALITY.map((preset) => ({ value: preset.id, label: preset.label }))}
          />
          <Caption>{quality.hint}</Caption>
          <Caption>
            {`Sending ${quality.w}px wide at quality ${quality.q}, up to ${quality.fps} fps. Applied to the running stream — no reconnect.`}
          </Caption>
          <Caption>
            {`Now: ${stream.stats.fps} fps · ${stream.stats.kbps} KB/s · ping ${facts.pingMs === null ? '—' : `${facts.pingMs} ms`}`}
          </Caption>
        </Column>
      </Sheet>

      <Sheet visible={showHelp} onClose={() => setShowHelp(false)} title="Controls & permissions" testID="help-sheet">
        <ScrollView style={{ maxHeight: 400 }} contentContainerStyle={{ gap: theme.space.sm }}>
          <Txt variant="bodyStrong">Touch mode</Txt>
          <Caption>
            Tap to click, long press to right-click. At 1× a drag becomes a mouse drag on the PC; once you zoom in, a
            drag pans the picture instead.
          </Caption>
          <Txt variant="bodyStrong">Trackpad mode</Txt>
          <Caption>
            Drag anywhere to nudge the cursor — it stays visible instead of hiding under your finger, which is the only
            way to hit small targets. Tap to click where the cursor sits.
          </Caption>
          <Txt variant="bodyStrong">Both modes</Txt>
          <Caption>
            Pinch to zoom, two-finger drag to scroll. The right-click and double-click controls in the dock arm the next
            tap only.
          </Caption>
          <Txt variant="bodyStrong">Key bar pages</Txt>
          <Caption>
            The key bar slides sideways — the dots under it count the pages. Basics, then arrows, then editing
            shortcuts, then app and system shortcuts: new tab, search, screenshots, quit and lock, each sending the
            right chord for the computer you are driving.
          </Caption>
          <Txt variant="bodyStrong">Modifier keys</Txt>
          <Caption>
            On the key bar, tap Ctrl, Alt, Shift or Win once to apply it to the next key; tap twice quickly to lock it
            until you tap it again. Tapping the remote screen clears un-locked modifiers.
          </Caption>
          <Txt variant="bodyStrong">macOS permissions</Txt>
          <Caption>{LAUNCHER_NOTE}</Caption>
          {MAC_STEPS.map((step, index) => (
            <Caption key={step}>{`${index + 1}. ${step}`}</Caption>
          ))}
          <Button label="Recheck the host" testID="recheck-permissions" variant="secondary" size="sm" onPress={recheck} />
        </ScrollView>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
