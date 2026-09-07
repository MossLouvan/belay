// The live desktop — the app's HOME.
//
// Desktop-first IA: this is the first thing a connected user sees and the
// surface everything else opens over. There is no tab bar any more; the
// control bar at the bottom (src/screen/dock.tsx) carries the pointer modes,
// the KEYS toggle, zoom, and TOOLS — the drawer that slides Agent, Terminal,
// Files and System up over the picture.
//
// Orientation: portrait shows header + stage + docked control bar, with an
// optional Full mode that hides the chrome. Landscape IS full — turning the
// phone sideways is the fullscreen gesture, so the desktop goes edge-to-edge
// automatically, the control bar floats on the HUD scrim, and the Full toggle
// disappears (it would be a no-op with a broken exit).
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
// This file is composition only: it wires the hooks together and lays the
// pieces out. The socket, the gesture model, every decision and every
// presentational piece live in `src/screen/*` — sibling files inside
// `app/(home)/` are picked up by expo-router's route context and would
// register as extra routes. The pure decisions are src/screen/screen-chrome.ts.

import { GamingOverlay, GamingSheet, useGaming } from '../../src/gamepad/gaming';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useIsFocused } from 'expo-router';
import { useConnection } from '../../src/connection';
import { useTheme } from '../../src/theme';
import { Rule, useReducedMotion } from '../../src/ui';
import { EMPTY_SIZE, fitBox, STREAM } from '../../src/screen/model';
import type { Size } from '../../src/screen/model';
import { aspectOf, isMacHost, readPermissions, useHostFacts, useScreenStream } from '../../src/screen/stream';
import { useViewport } from '../../src/screen/viewport';
import { useRemoteCursors } from '../../src/screen/cursors-store';
import { NoticeArea } from '../../src/screen/parts';
import { EdgeRevealStrip } from '../../src/screen/edge-reveal';
import { useScreenBack } from '../../src/screen/use-screen-back';
import { PAD_CURSOR_LINGER_MS } from '../../src/screen/trackpad';
import { RecordSheet, RecordStrip, SentNotice } from '../../src/screen/record-parts';
import { ClipboardSheet } from '../../src/screen/clipboard-sheet';
import { StreamSettingsSheet } from '../../src/screen/stream-settings-sheet';
import { HostAudio } from '../../src/stream/audio-player';
import { ToolDrawer } from '../../src/home/tool-drawer';
import { ControlColumn } from '../../src/screen/control-column';
import { DockedControls, FloatingDock } from '../../src/screen/floating-dock';
import { HelpSheet } from '../../src/screen/help-sheet';
import { ImmersiveHud } from '../../src/screen/immersive-hud';
import { QualitySheet } from '../../src/screen/quality-sheet';
import type { BwpPreference } from '../../src/screen/bwp-policy';
import { hintVisible, panelStateShown, typeRowFloats } from '../../src/screen/screen-chrome';
import { ScreenHeader } from '../../src/screen/screen-header';
import { MonitorSheet, ScreenMenuSheet } from '../../src/screen/screen-menu-sheet';
import { StageView } from '../../src/screen/stage-view';
import { FloatingTypeBar, TypeRow } from '../../src/screen/type-row';
import { useDockState } from '../../src/screen/use-dock-state';
import { useImmersive } from '../../src/screen/use-immersive';
import { useKeySender } from '../../src/screen/use-key-sender';
import { useMascotLatch } from '../../src/screen/use-mascot-latch';
import { useMonitorChoice } from '../../src/screen/use-monitor-choice';
import { useRecordControls } from '../../src/screen/use-record-controls';
import { useScreenSheets } from '../../src/screen/use-screen-sheets';
import { useQualityAvailability, useStreamPresets } from '../../src/screen/use-stream-presets';
import { useToolsHint } from '../../src/screen/use-tools-hint';
import { useTransient } from '../../src/screen/use-transient';
import { useTypeRow } from '../../src/screen/use-type-row';

// Where the open type row lives is a platform constant (so the Input never
// remounts and drops focus) — see screen-chrome.ts typeRowFloats.
const TYPE_ROW_FLOATS = typeRowFloats(Platform.OS);

export default function ScreenTab() {
  const { connection, phase: linkPhase } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const focused = useIsFocused();
  const active = Boolean(connection) && focused;
  const gaming = useGaming(active, `${connection?.host ?? ''}|${connection?.token ?? ''}`);

  const view = useImmersive(gaming.enabled);
  const { immersive, fullscreen, landscape } = view;
  const presets = useStreamPresets(active, view.device);
  const sheets = useScreenSheets();
  const [box, setBox] = useState<Size>(EMPTY_SIZE);

  // The tab navigator keeps every visited route mounted, so `connection` alone
  // would leave the frame socket, the 15s info poll and the per-second stats
  // ticker running while the user works in Terminal or Files. Gating on focus
  // as well releases all three the moment the tab goes off screen.
  const facts = useHostFacts(active);
  const monitors = useMonitorChoice(facts.info);
  const { screenIndex } = monitors;

  // The H.264 switch. 'auto' is the default and means "whenever the host can";
  // the other two exist for the moment a user needs to prove which path is
  // misbehaving. Not persisted: a forced choice is a diagnostic, not a setting.
  const [bwpPreference, setBwpPreference] = useState<BwpPreference>('auto');
  // The host's H.264 flag comes from the same /screen/info poll as everything
  // else about it; undefined until the first answer, which the policy treats
  // as "ask and see" rather than "no".
  const bwpOptions = useMemo(
    () => ({ preference: bwpPreference, hostBwp: facts.info?.bwp }),
    [bwpPreference, facts.info?.bwp],
  );
  const stream = useScreenStream(active, presets.quality, screenIndex, presets.virtualRequest, gaming.enabled, bwpOptions);
  const qualityChoices = useQualityAvailability(stream.bwpPath, presets, gaming.enabled);

  const permissions = useMemo(() => readPermissions(facts.info, stream.error), [facts.info, stream.error]);
  const isMac = isMacHost(facts.info);

  // The stage is sized to the remote aspect ratio so the picture fills it
  // exactly: no letterboxing means touch coordinates map straight through.
  const aspect = useMemo(
    () => aspectOf(stream.stats, facts.info, { width: stream.bwpWidth, height: stream.bwpHeight }),
    [facts.info, stream.stats, stream.bwpWidth, stream.bwpHeight],
  );
  const stage = useMemo(() => fitBox(box, aspect), [box, aspect]);
  const stageRef = useRef<Size>(EMPTY_SIZE);
  stageRef.current = stage;

  // Transient toast for one-shot input failures.
  const toast = useTransient<string>(STREAM.toastMs);
  const reportError = toast.show;

  const tools = useToolsHint();
  const typing = useTypeRow(reportError);
  const dock = useDockState({ immersive, typeOpen: typing.typeOpen, dismissHint: tools.dismissHint });
  const keys = useKeySender({ isMac, reportError });

  // The deadspace pad drives the shared cursor whatever the pointer mode is;
  // while it does — and for a short linger after — the crosshair shows over
  // the picture, so the user can see where a pad tap would click even with
  // the dock set to touch or scroll.
  const padTouch = useTransient<true>(PAD_CURSOR_LINGER_MS);
  const padCursor = padTouch.value === true;
  const onPadInput = useCallback(() => padTouch.show(true), [padTouch.show]);

  // The collaboration channel: everyone else's cursor coming in, ours going
  // out. Only while this tab is live — an unfocused tab has nobody pointing.
  const room = useRemoteCursors(active && !gaming.enabled);

  const viewport = useViewport({
    sizeRef: stageRef,
    mode: dock.mode,
    button: dock.button,
    onButtonUsed: dock.clearButton,
    onError: reportError,
    reducedMotion,
    inputBlocked: permissions.inputBlocked || gaming.enabled,
    screen: screenIndex,
    onPointer: keys.spendLatch,
    onCursor: room.send,
    activeMods: keys.activeModsForHost,
    onSwipe: keys.onSwipe,
    isMac,
    onPadInput,
  });

  const onBoxLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  const recheck = useCallback(() => {
    facts.refresh();
    stream.retry();
  }, [facts, stream]);

  const record = useRecordControls({ active, screenIndex, reportError });
  const mascot = useMascotLatch();
  // The explicit way off the desktop. The navigator's swipe-back is off on
  // this route (app/_layout.tsx): it ran full-width on iOS 26 and ate
  // trackpad drags on the black stage. Portrait carries it as the header's
  // leading ‹; the immersive dock carries a labelled Back key.
  const goBack = useScreenBack();

  const openHelp = sheets.opener('help');
  const openMenu = sheets.opener('menu');
  const openGaming = useCallback(() => gaming.setSheet(true), [gaming.setSheet]);

  const showPanelState = panelStateShown({
    captureBlocked: permissions.captureBlocked,
    frameUri: stream.frameUri,
    bwp: stream.bwp,
  });
  const noticeArea = <NoticeArea permissions={permissions} actionError={toast.value} onHelp={openHelp} />;
  const typeRow = (
    <TypeRow text={typing.text} onChangeText={typing.setText} onSend={typing.sendText} onClose={typing.closeType} />
  );

  const controls = (
    <ControlColumn
      isMac={isMac}
      immersive={immersive}
      keys={keys}
      dock={dock}
      monitors={monitors}
      viewport={viewport}
      tools={tools}
      hint={hintVisible({ immersive, hintSeen: tools.hintSeen, connected: Boolean(connection) })}
      typeRow={typing.typeOpen && !TYPE_ROW_FLOATS ? typeRow : null}
      typeOpen={typing.typeOpen}
      onToggleType={typing.toggleType}
      onOpenGaming={openGaming}
      onOpenMonitorPicker={sheets.opener('monitor')}
      recordPhase={record.recordPhase}
      onRecord={record.onRecordKey}
      onOpenClipboard={sheets.opener('clipboard')}
      onOpenMenu={openMenu}
      onBack={goBack}
    />
  );

  return (
    // A plain root: keyboard handling is the floating type bar's job (see
    // use-type-row.ts), so the stage and dock never re-flow.
    <View
      ref={typing.rootRef}
      style={{
        flex: 1,
        backgroundColor: immersive ? theme.colors.machine : theme.colors.bg,
        paddingTop: immersive ? 0 : insets.top,
      }}
    >
      {/* Mounted only while immersive: RN's status bar restores the previous
          entry when this unmounts, so the root layout's style survives. */}
      {immersive ? <StatusBar hidden /> : null}

      {/* The host-audio sink (hidden). Gated on `active` too, so leaving the
          tab or backgrounding stops the socket and the speaker with it. */}
      <HostAudio enabled={sheets.audioOn} connected={active} />

      {!immersive ? (
        <ScreenHeader
          hostName={connection?.hostName}
          linkPhase={linkPhase}
          mascotLabel={mascot.mascotLabel}
          onMascotPress={mascot.onMascotPress}
          onBack={goBack}
          onOpenMenu={openMenu}
        />
      ) : null}

      {/* The recording strip sits above the panel where the eye already goes
          for stream status; while the host's screen is being captured it must
          be impossible to miss, so it never shares a sheet or a toggle. */}
      {!immersive ? (
        <RecordStrip status={record.recording.status} onStop={record.stopRecording} onReview={record.openRecordSheet} />
      ) : null}
      {!immersive && record.sent ? <SentNotice info={record.sent} onOpen={record.openSentSession} /> : null}
      {!immersive ? noticeArea : null}
      {!immersive ? <Rule /> : null}

      <StageView
        onBoxLayout={onBoxLayout}
        box={box}
        stage={stage}
        aspect={aspect}
        viewport={viewport}
        stream={stream}
        room={room}
        screenIndex={screenIndex}
        quality={presets.quality}
        pingMs={facts.pingMs}
        permissions={permissions}
        mode={dock.mode}
        padCursor={padCursor}
        showHud={sheets.showHud}
        showPanelState={showPanelState}
        gamingEnabled={gaming.enabled}
        immersive={immersive}
        fullscreen={fullscreen}
        landscape={landscape}
        connected={Boolean(connection)}
        hostName={connection?.hostName || 'The computer'}
        onRetry={recheck}
        onHelp={openHelp}
        onToggleFullscreen={view.toggleFullscreen}
      >
        {/* Input errors still matter while immersive; they float over the top edge. */}
        {immersive && !gaming.enabled ? (
          <ImmersiveHud
            mascotLabel={mascot.mascotLabel}
            onMascotPress={mascot.onMascotPress}
            recordingStatus={record.recording.status}
            onStopRecording={record.stopRecording}
            onReviewRecording={record.openRecordSheet}
            sent={record.sent}
            onOpenSent={record.openSentSession}
          >
            {noticeArea}
          </ImmersiveHud>
        ) : null}
      </StageView>

      {gaming.enabled ? null : !immersive ? (
        <DockedControls>{controls}</DockedControls>
      ) : (
        <FloatingDock shown={dock.dockShown} opacity={dock.dockOpacity} onHide={dock.dockHide.hide}>
          {controls}
        </FloatingDock>
      )}

      {/* While the immersive bar is away, a thin strip on the very bottom
          edge waits for the reveal swipe. Kept mounted to avoid flicker;
          disabled via pointerEvents when not needed. */}
      {immersive && !gaming.enabled ? (
        <EdgeRevealStrip testID="edge-reveal" bottomInset={insets.bottom} onReveal={dock.dockHide.poke} disabled={dock.dockShown} />
      ) : null}

      {/* The type-to-PC row, floating on the keyboard's top edge (iOS). */}
      {typing.typeOpen && TYPE_ROW_FLOATS && !gaming.enabled ? (
        <FloatingTypeBar lift={typing.typeBarLift} immersive={immersive}>
          {typeRow}
        </FloatingTypeBar>
      ) : null}

      {gaming.enabled ? <GamingOverlay gaming={gaming} width={view.window.width} height={view.window.height}
        fps={stream.bwpStats?.fps ?? stream.stats.fps} pingMs={facts.pingMs} /> : null}
      <GamingSheet gaming={gaming} />

      {/* Gated on `ready`, not just the flag: a stop that failed leaves
          nothing to send, and a sheet promising to send nothing would lie. */}
      <RecordSheet
        visible={record.showRecordSheet && record.recordPhase === 'ready'}
        onClose={record.closeRecordSheet}
        status={record.recording.status}
        busy={record.recording.busy}
        onSend={record.recording.send}
        onDiscard={() => void record.recording.discard()}
        onSent={record.onSent}
      />

      <ClipboardSheet visible={sheets.isOpen('clipboard')} onClose={sheets.closer('clipboard')} />

      <StreamSettingsSheet
        visible={sheets.isOpen('streamSettings')}
        onClose={sheets.closer('streamSettings')}
        settings={sheets.streamSettings}
        onApply={(settings) => {
          sheets.applyStreamSettings(settings);
          // Wire to WebRTC ABR: send control message to update encoder bitrate ceiling
          // Control channel message: {"t":"bitrate","bps":settings.bitrateMbps*1_000_000}
          // If bitrateMbps === 0 (Auto), congestion.ts decides with no ceiling
          // On JPEG fallback: bitrate maps indirectly via quality/width presets
          if (connection && settings.bitrateMbps > 0) {
            const bps = settings.bitrateMbps * 1_000_000;
            // TODO: Send via WebRTC control channel when session is WebRTC-backed
            // For now this state is read by quality presets and HUD
            console.log(`[stream-settings] bitrate ceiling: ${bps} bps (${settings.bitrateMbps} Mbps)`);
          }
        }}
        webrtcAvailable={facts.info?.webrtc === true}
      />

      {/* The tool drawer: the four former tabs, named and explained, each
          opening as a slide-up panel over this desktop. */}
      <ToolDrawer visible={tools.showTools} onClose={tools.closeTools} waitingCount={tools.waitingCount} />

      <ScreenMenuSheet
        visible={sheets.isOpen('menu')}
        onClose={sheets.closer('menu')}
        quality={presets.quality}
        streamSettings={sheets.streamSettings}
        showHud={sheets.showHud}
        audioOn={sheets.audioOn}
        onOpenQuality={sheets.fromMenu('quality')}
        onOpenStreamSettings={sheets.fromMenu('streamSettings')}
        onToggleHud={sheets.toggleHud}
        onToggleAudio={sheets.toggleAudio}
        onOpenHelp={sheets.fromMenu('help')}
      />

      <MonitorSheet
        visible={sheets.isOpen('monitor')}
        onClose={sheets.closer('monitor')}
        screens={monitors.screens}
        screenIndex={screenIndex}
        onSelect={monitors.selectScreen}
      />

      <QualitySheet
        visible={sheets.isOpen('quality')}
        onClose={sheets.closer('quality')}
        presets={presets}
        qualityChoices={qualityChoices}
        stream={stream}
        bwpPreference={bwpPreference}
        onBwpPreference={setBwpPreference}
        pingMs={facts.pingMs}
        zoom={viewport.zoom}
      />

      <HelpSheet visible={sheets.isOpen('help')} onClose={sheets.closer('help')} onRecheck={recheck} />
    </View>
  );
}
