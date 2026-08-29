// Remote screen — the flagship surface.
//
// Streams JPEG frames from the host over a WebSocket into a zoomable, pannable
// stage. Two pointer models are offered: direct touch (tap where you want to
// click) and trackpad (drag anywhere to nudge a visible cursor), because hitting
// a 12px checkbox on a 1710x1107 desktop from a phone is otherwise guesswork.
//
// The socket, the gesture model and the presentational pieces live in
// `src/screen/*` — sibling files inside `app/(tabs)/` are picked up by
// expo-router's route context and would register as extra tabs.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, LayoutChangeEvent, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from 'expo-router';
import { useConnection } from '../../src/connection';
import { api } from '../../src/api';
import { useTheme } from '../../src/theme';
import {
  Badge,
  Button,
  Caption,
  Column,
  Dot,
  Input,
  Row,
  SegmentedControl,
  Sheet,
  Txt,
  haptic,
  useReducedMotion,
} from '../../src/ui';
import {
  DEFAULT_QUALITY,
  EMPTY_SIZE,
  fitBox,
  findQuality,
  GESTURE,
  KEYS,
  KeySpec,
  LAUNCHER_NOTE,
  MAC_STEPS,
  messageOf,
  modsFor,
  QUALITY,
  QualityId,
  Size,
  STREAM,
} from '../../src/screen/model';
import {
  aspectOf,
  isMacHost,
  PHASE_LABEL,
  readPermissions,
  useHostFacts,
  useScreenStream,
} from '../../src/screen/stream';
import { PendingButton, PointerMode, useViewport } from '../../src/screen/viewport';
import { resolveScreenIndex, screensOf } from '../../src/screen/monitors';
import {
  CaptureBlocked,
  Chip,
  Crosshair,
  KeyCap,
  MonitorSwitcher,
  NoticeArea,
  StageMessage,
  statusColorFor,
  StreamHud,
  ZoomControls,
} from '../../src/screen/parts';

export default function ScreenTab() {
  const { connection } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();

  const [qualityId, setQualityId] = useState<QualityId>(DEFAULT_QUALITY);
  const [mode, setMode] = useState<PointerMode>('touch');
  const [button, setButton] = useState<PendingButton>('none');
  const [showKeys, setShowKeys] = useState(true);
  const [showHud, setShowHud] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [text, setText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [box, setBox] = useState<Size>(EMPTY_SIZE);

  const quality = useMemo(() => findQuality(qualityId), [qualityId]);

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
  const displays = facts.info?.displays ?? 0;

  // The stage is sized to the remote aspect ratio so the picture fills it
  // exactly: no letterboxing means touch coordinates map straight through.
  const aspect = useMemo(() => aspectOf(stream.stats, facts.info), [facts.info, stream.stats]);
  const stage = useMemo(() => fitBox(box, aspect), [box, aspect]);
  const stageRef = useRef<Size>(EMPTY_SIZE);
  stageRef.current = stage;

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
  const viewport = useViewport({
    sizeRef: stageRef,
    mode,
    button,
    onButtonUsed: clearButton,
    onError: reportError,
    reducedMotion,
    inputBlocked: permissions.inputBlocked,
    screen: screenIndex,
  });

  const onBoxLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  const sendKey = useCallback(
    (spec: KeySpec) => {
      haptic('light');
      api
        .key(spec.key, modsFor(spec, isMac))
        .catch((e: unknown) => reportError(`Key ${spec.id} failed — ${messageOf(e)}`));
    },
    [isMac, reportError]
  );

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

  const live = stream.phase === 'live';
  const connecting = stream.phase === 'connecting' || stream.phase === 'reconnecting';

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
      <Row justify="space-between" style={{ paddingHorizontal: theme.space.md, paddingBottom: theme.space.xs }}>
        <Row gap="xs" style={{ flexShrink: 1 }}>
          <Dot color={statusColorFor(stream.phase, theme)} pulse={connecting} label={PHASE_LABEL[stream.phase]} />
          <Txt variant="subheading" numberOfLines={1}>
            {connection?.hostName || 'Screen'}
          </Txt>
          {displays > 1 ? <Badge label={`${displays} displays`} status="neutral" /> : null}
        </Row>
        <Row gap="xs">
          <Txt testID="fps" variant="caption" tone="faint">
            {live ? `${stream.stats.fps} fps` : PHASE_LABEL[stream.phase]}
          </Txt>
          <Chip
            label="HUD"
            active={showHud}
            onPress={() => setShowHud((v) => !v)}
            testID="toggle-hud"
            accessibilityLabel="Toggle the connection quality overlay"
          />
        </Row>
      </Row>

      <NoticeArea
        permissions={permissions}
        phase={stream.phase}
        attempt={stream.attempt}
        streamError={stream.error}
        actionError={actionError}
        onHelp={() => setShowHelp(true)}
        onRetry={recheck}
      />

      <View
        onLayout={onBoxLayout}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.space.sm }}
      >
        <View
          testID="screen-surface"
          accessibilityLabel="Remote screen. Tap to click, long press to right-click, pinch to zoom, two fingers to scroll."
          {...viewport.handlers}
          style={{
            width: stage.w > 0 ? stage.w : '100%',
            height: stage.h > 0 ? stage.h : undefined,
            aspectRatio: stage.h > 0 ? undefined : aspect,
            backgroundColor: theme.colors.black,
            borderRadius: theme.radius.md,
            overflow: 'hidden',
            borderWidth: theme.layout.hairline,
            borderColor: theme.colors.border,
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

          {!stream.frameUri && !permissions.captureBlocked ? (
            <StageMessage phase={stream.phase} attempt={stream.attempt} hostName={connection?.hostName || 'the host'} />
          ) : null}

          {showHud ? (
            <StreamHud stats={stream.stats} pingMs={facts.pingMs} quality={quality} zoom={viewport.zoom} />
          ) : null}

          {/* Zooming a picture that will never arrive is just clutter. */}
          {permissions.captureBlocked ? null : (
            <ZoomControls
              zoom={viewport.zoom}
              onZoomIn={() => viewport.zoomBy(GESTURE.zoomStep)}
              onZoomOut={() => viewport.zoomBy(1 / GESTURE.zoomStep)}
              onReset={viewport.reset}
            />
          )}
        </View>

        {/* Outside the stage, which clips: the explanation needs the full area. */}
        {permissions.captureBlocked ? (
          <CaptureBlocked known={permissions.known} onHelp={() => setShowHelp(true)} onRetry={recheck} />
        ) : null}
      </View>

      <Column
        gap="sm"
        style={{
          paddingHorizontal: theme.space.sm,
          paddingTop: theme.space.xs,
          paddingBottom: insets.bottom + theme.space.sm,
        }}
      >
        {/* Renders only when the host reports more than one monitor.
            TODO(ui): restyled by the UI redesign pass. */}
        <MonitorSwitcher screens={screens} selected={screenIndex} onSelect={setSelectedScreen} />

        <SegmentedControl
          testID="pointer-mode"
          accessibilityLabel="Pointer mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'touch', label: 'Touch' },
            { value: 'trackpad', label: 'Trackpad' },
          ]}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.space.xs, paddingRight: theme.space.sm }}
        >
          <Chip
            label={button === 'right' ? 'Right-click: ON' : 'Right-click'}
            active={button === 'right'}
            onPress={() => setButton((b) => (b === 'right' ? 'none' : 'right'))}
            testID="right-click"
          />
          <Chip
            label={button === 'double' ? 'Double-click: ON' : 'Double-click'}
            active={button === 'double'}
            onPress={() => setButton((b) => (b === 'double' ? 'none' : 'double'))}
            testID="double-click"
          />
          <Chip label={showKeys ? 'Hide keys' : 'Show keys'} onPress={() => setShowKeys((v) => !v)} testID="toggle-keys" />
          <Chip
            label={quality.label}
            onPress={() => setShowQuality(true)}
            testID="quality"
            accessibilityLabel={`Stream quality: ${quality.label}`}
          />
          <Chip label="Help" onPress={() => setShowHelp(true)} testID="screen-help" />
        </ScrollView>

        {showKeys ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6, paddingRight: theme.space.sm }}
          >
            {KEYS.map((spec) => (
              <KeyCap key={spec.id} spec={spec} onPress={sendKey} mac={isMac} />
            ))}
          </ScrollView>
        ) : null}

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
          />
          <Button testID="send-text" label="Send" onPress={sendText} size="sm" />
        </Row>
      </Column>

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
            Pinch to zoom, two-finger drag to scroll. The Right-click and Double-click chips arm the next tap only.
          </Caption>
          <Txt variant="bodyStrong">macOS permissions</Txt>
          <Caption>{LAUNCHER_NOTE}</Caption>
          {MAC_STEPS.map((step, index) => (
            <Caption key={step}>{`${index + 1}. ${step}`}</Caption>
          ))}
          <Button label="Recheck the host" testID="recheck-permissions" variant="secondary" size="sm" onPress={recheck} />
        </ScrollView>
      </Sheet>
    </View>
  );
}
