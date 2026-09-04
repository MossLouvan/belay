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
// The socket, the gesture model and the presentational pieces live in
// `src/screen/*` — sibling files inside `app/(home)/` are picked up by
// expo-router's route context and would register as extra routes.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, Keyboard, Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { router, useIsFocused } from 'expo-router';
import { useConnection } from '../../src/connection';
import { api } from '../../src/api';
import { useTheme } from '../../src/theme';
import {
  Button,
  Caption,
  Column,
  ConnectionStatus,
  IconButton,
  Input,
  ListItem,
  Row,
  Rule,
  SegmentedControl,
  Sheet,
  Txt,
  haptic,
  useKeyboardLift,
  useReducedMotion,
  useToggleAnimation,
} from '../../src/ui';
import {
  DEFAULT_QUALITY,
  EMPTY_SIZE,
  fitBox,
  findQuality,
  findResolution,
  GESTURE,
  keyFor,
  KEYS,
  LAUNCHER_NOTE,
  MAC_STEPS,
  messageOf,
  modsFor,
  PHYSICAL_RESOLUTION_ID,
  QUALITY,
  resolutionOptions,
  STREAM,
  virtualRequestFor,
} from '../../src/screen/model';
import type { KeySpec, QualityId, Size } from '../../src/screen/model';
import {
  aspectOf,
  isMacHost,
  readPermissions,
  useHostFacts,
  useScreenStream,
} from '../../src/screen/stream';
import { useViewport } from '../../src/screen/viewport';
import type { PendingButton, PointerMode } from '../../src/screen/viewport';
import { SWIPE_ACTION_ID } from '../../src/screen/swipe';
import type { SwipeDirection } from '../../src/screen/swipe';
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
  FullscreenGlyph,
  HUD,
  KeyBar,
  NoticeArea,
  StageButton,
  StreamHud,
} from '../../src/screen/parts';
import { ControlDock } from '../../src/screen/dock';
import { PanelState } from '../../src/screen/panel-state';
import { RecordSheet, RecordStrip, SentNotice } from '../../src/screen/record-parts';
import { ClipboardSheet } from '../../src/screen/clipboard-sheet';
import type { SentInfo } from '../../src/screen/record-parts';
import { SENT_NOTICE_MS } from '../../src/screen/record';
import { useRecording } from '../../src/screen/useRecording';
import { setOpenSession, useAgentAttention } from '../../src/agent/attention-store';
import { waitingSessions } from '../../src/agent/attention';
import { NeedsYouBanner } from '../../src/agent/needs-you-banner';
import { SwitchComputerLink } from '../../src/devices/switch-link';
import { HostAudio } from '../../src/stream/audio-player';
import { ToolDrawer } from '../../src/home/tool-drawer';
import { loadHintSeen, persistHintSeen } from '../../src/home/hint-store';

// Where the open type row lives is a platform constant (so the Input never
// remounts and drops focus). Only iOS overlays its keyboard on the app — there
// the row floats and rides the keyboard's top edge. Android's adjustResize
// shrinks the window above the keyboard and the web has no on-screen keyboard
// at all, so both keep the row inline in the control column.
const TYPE_ROW_FLOATS = Platform.OS === 'ios';

export default function ScreenTab() {
  const { connection, phase: linkPhase } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();

  const [qualityId, setQualityId] = useState<QualityId>(DEFAULT_QUALITY);
  // The NEW true-resolution axis (Parsec-style), orthogonal to quality:
  // `resolutionId` picks WHAT the host renders, quality picks how it is encoded.
  // Defaults to the physical screen, which every host can do; the virtual
  // options only take effect once the host advertises `vdAvailable`.
  const [resolutionId, setResolutionId] = useState<string>(PHYSICAL_RESOLUTION_ID);
  const [vdAvailable, setVdAvailable] = useState(false);
  const [mode, setMode] = useState<PointerMode>('touch');
  const [button, setButton] = useState<PendingButton>('none');
  const [fullscreen, setFullscreen] = useState(false);
  const [keysOn, setKeysOn] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [mods, setMods] = useState<ModsState>(IDLE_MODS);
  const [showHud, setShowHud] = useState(false);
  // Host system audio on the phone's speaker. Default OFF: it is opt-in and
  // rides the BELAY_WEBRTC-gated /ws/audio, so a host without the flag simply
  // never delivers frames and the toggle is a harmless no-op.
  const [audioOn, setAudioOn] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showMonitorPicker, setShowMonitorPicker] = useState(false);
  const [text, setText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [box, setBox] = useState<Size>(EMPTY_SIZE);

  const quality = useMemo(() => findQuality(qualityId), [qualityId]);

  // "Match my phone" needs the device's own pixel size (logical points × the
  // display scale), so the host can render a desktop of exactly this shape.
  const window = useWindowDimensions();
  const device = useMemo<Size>(
    () => ({ w: window.width * window.scale, h: window.height * window.scale }),
    [window.width, window.height, window.scale],
  );
  // Landscape is the fullscreen gesture: sideways, the desktop goes
  // edge-to-edge on its own and the chrome floats. The explicit Full toggle
  // is a portrait-only idea, so rotating clears it — otherwise coming back
  // upright would strand the user in a fullscreen they never chose, behind
  // an exit control they already found hard to hit.
  const landscape = window.width > window.height;
  const immersive = fullscreen || landscape;
  useEffect(() => {
    if (landscape && fullscreen) setFullscreen(false);
  }, [landscape, fullscreen]);

  const resolutions = useMemo(() => resolutionOptions(device), [device]);
  const resolution = useMemo(() => findResolution(resolutionId, resolutions), [resolutionId, resolutions]);
  // The request handed to the stream: null (physical) unless the host both
  // advertises the feature AND this option maps to a real size. That gate is
  // the app-side half of the graceful fallback — a host without it never even
  // gets asked, so the shipping downscale path is what runs.
  const virtualRequest = useMemo(
    () => (vdAvailable ? virtualRequestFor(resolution) : null),
    [vdAvailable, resolution],
  );

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

  const stream = useScreenStream(active, quality, screenIndex, virtualRequest);

  // Probe once per active session whether this host can render at a chosen
  // resolution. A 403 (flag off) or an unreachable host resolves to false
  // inside the api helper, so the true-resolution picker simply stays hidden
  // on hosts that cannot do it — no error, no broken option.
  useEffect(() => {
    if (!active) { setVdAvailable(false); return; }
    let disposed = false;
    void api.virtualDisplayStatus().then((s) => {
      if (!disposed) setVdAvailable(s.available);
    });
    return () => { disposed = true; };
  }, [active]);

  const permissions = useMemo(() => readPermissions(facts.info, stream.error), [facts.info, stream.error]);
  const isMac = isMacHost(facts.info);

  // The stage is sized to the remote aspect ratio so the picture fills it
  // exactly: no letterboxing means touch coordinates map straight through.
  const aspect = useMemo(() => aspectOf(stream.stats, facts.info), [facts.info, stream.stats]);
  const stage = useMemo(() => fitBox(box, aspect), [box, aspect]);
  const stageRef = useRef<Size>(EMPTY_SIZE);
  stageRef.current = stage;

  // In (portrait) fullscreen the floating dock hides after 4s untouched;
  // while the text field is open it stays put (the keyboard is up — hiding
  // under the user's thumbs would be hostile). Stage touches never poke this:
  // they are remote input, and the only reveal is the pinned corner control.
  // Landscape deliberately never auto-hides: rotation has no Exit control to
  // poke the bar back, so the floating bar simply stays.
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
  // A committed three-finger swipe becomes the host OS's own desktop-switch
  // chord. Latched modifiers are deliberately NOT mixed in: like pans and
  // zooms, the swipe is navigation, not a keystroke the user is composing.
  const onSwipe = useCallback(
    (direction: SwipeDirection) => {
      const spec = KEYS.find((key) => key.id === SWIPE_ACTION_ID[direction]);
      if (!spec) return;
      api
        .key(keyFor(spec, isMac), modsFor(spec, isMac))
        .catch((e: unknown) => reportError(`Desktop switch failed — ${messageOf(e)}`));
    },
    [isMac, reportError]
  );
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
    onSwipe,
  });

  const onBoxLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  // Modifiers resolved by the press that started a hold. Repeats reuse them so
  // a held Ctrl+Backspace keeps deleting WORDS, even though the latch was
  // released the moment the first key went out.
  const heldModsRef = useRef<readonly string[]>([]);

  const sendKey = useCallback(
    (spec: KeySpec) => {
      haptic('light');
      const base = modsFor(spec, isMac);
      const latched = modNamesForHost(activeMods(modsRef.current), isMac).filter((m) => !base.includes(m));
      const mods = [...latched, ...base];
      heldModsRef.current = mods;
      setMods(releaseLatched);
      // Returned so the key bar's auto-repeat can pace itself on the round
      // trip instead of queueing sends a slow link cannot keep up with.
      return api
        .key(keyFor(spec, isMac), mods)
        .catch((e: unknown) => reportError(`Key ${spec.id} failed — ${messageOf(e)}`));
    },
    [isMac, reportError]
  );

  /**
   * One auto-repeat of a key being held down. No haptic (eighteen a second is
   * a buzz, not feedback) and no latch bookkeeping — just the same chord the
   * press sent, again.
   */
  const repeatKey = useCallback(
    (spec: KeySpec) =>
      api
        .key(keyFor(spec, isMac), [...heldModsRef.current])
        .catch((e: unknown) => reportError(`Key ${spec.id} failed — ${messageOf(e)}`)),
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

  // Host-side screen recording, for handing frames to a Claude session. The
  // capture runs — and the frames stay — on the computer; this is only the
  // switch. It records the monitor currently being streamed, so what the user
  // is looking at is what Claude gets.
  const recording = useRecording(active, reportError);
  const [showRecordSheet, setShowRecordSheet] = useState(false);
  // Clipboard sync lives in its own small sheet; the dock's CLIP key opens it.
  const [showClipboard, setShowClipboard] = useState(false);

  // Desktop-first chrome: the tool drawer (Agent/Terminal/Files/System) and
  // the one-time hint that points a brand-new user at the control bar. The
  // waiting count is the old Agent tab badge, now on the TOOLS key and the
  // drawer's Agent row.
  const [showTools, setShowTools] = useState(false);
  const { sessions } = useAgentAttention();
  const waitingCount = waitingSessions(sessions ?? []).length;
  /** null while the stored flag loads — the hint never flashes on first paint. */
  const [hintSeen, setHintSeen] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void loadHintSeen().then((seen) => {
      if (live) setHintSeen(seen);
    });
    return () => {
      live = false;
    };
  }, []);
  const dismissHint = useCallback(() => {
    setHintSeen((seen) => {
      if (seen !== true) void persistHintSeen();
      return true;
    });
  }, []);
  const openTools = useCallback(() => {
    dismissHint();
    setShowTools(true);
  }, [dismissHint]);
  const recordPhase = recording.status.state;
  const onRecordKey = useCallback(() => {
    if (recordPhase === 'idle') void recording.start(screenIndex);
    else if (recordPhase === 'recording') void recording.stop();
    else setShowRecordSheet(true);
  }, [recordPhase, recording, screenIndex]);
  // Stopping opens the review sheet directly: the whole point of the stop was
  // to hand the clip to Claude, so the handoff should not hide behind a
  // second tap on a key that now reads SEND.
  const stopRecording = useCallback(() => {
    void recording.stop().then(() => setShowRecordSheet(true));
  }, [recording]);

  // The frames left; the user must not have to wonder whether they arrived.
  // The notice holds for a few seconds with the one-tap way into the session,
  // then stands down — it is a receipt, not a permanent fixture.
  const [sent, setSent] = useState<SentInfo | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSent = useCallback((info: SentInfo) => {
    setSent(info);
    if (sentTimer.current) clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setSent(null), SENT_NOTICE_MS);
  }, []);
  useEffect(
    () => () => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
    },
    []
  );
  const openSentSession = useCallback(() => {
    if (!sent) return;
    setSent(null);
    setOpenSession(sent.sessionId);
    router.navigate('/agent');
  }, [sent]);

  // The KEYS toggle now lives in the control bar (the founder's call: an eye
  // glyph on the stage was the one control nobody found). In full screen a
  // press also pokes the auto-hidden dock back, so the key bar that appears
  // has its companion controls on screen with it.
  const toggleKeys = useCallback(() => {
    dismissHint();
    if (fullscreen) dockHide.poke();
    setKeysOn((v) => !v);
  }, [fullscreen, dockHide, dismissHint]);
  const toggleFullscreen = useCallback(() => {
    // The floating type bar is anchored to this layout's bottom edge; the
    // fullscreen flip moves that edge without a keyboard event to re-measure
    // against. Dismissing first lets the keyboard-gone effect fold the row
    // cleanly (the draft survives in `text`); with no keyboard up, a no-op.
    Keyboard.dismiss();
    setFullscreen((v) => !v);
  }, []);

  // The one remaining stage control: Full / Exit, portrait only (Keys moved
  // into the control bar, and landscape is already edge-to-edge). A single
  // clearly-labelled button in a known corner — never a bare glyph box.
  const stageControls = (positionStyle: object) => (
    <View style={[{ position: 'absolute', flexDirection: 'row', gap: theme.space.xxs }, positionStyle]}>
      <StageButton
        testID="stage-fullscreen"
        glyph={<FullscreenGlyph mode={fullscreen ? 'collapse' : 'expand'} color={HUD.ink} />}
        label={fullscreen ? 'Exit' : 'Full'}
        accessibilityLabel={fullscreen ? 'Exit full screen' : 'Enter full screen'}
        onPress={toggleFullscreen}
      />
    </View>
  );

  const showPanelState = permissions.captureBlocked || !stream.frameUri;

  const noticeArea = <NoticeArea permissions={permissions} actionError={actionError} onHelp={() => setShowHelp(true)} />;

  // The visible way out of the keyboard (docs/DESIGN.md §11.2). This surface
  // has no scrollable to drag and no safe "outside" to tap — every stage touch
  // is a remote mouse click — so without this × the only exits were sending
  // unwanted text or knowing to re-press the unmarked TYPE toggle.
  const closeType = useCallback(() => {
    Keyboard.dismiss();
    setTypeOpen(false);
  }, []);

  // The type row floats over the layout and rides the keyboard's own
  // animation, instead of a root KeyboardAvoidingView shrinking the page.
  // Padding the root squished the flex video stage by the keyboard's height
  // (a violent refit of the live picture) and, in fullscreen, yanked the
  // absolutely-positioned dock up mid-video — the "Type breaks the UI" bug.
  // The lift is measured against this root view, so it lands exactly on the
  // keyboard's top edge whether the tab bar is there (non-fullscreen) or not.
  const rootRef = useRef<View>(null);
  const keyboard = useKeyboardLift(rootRef);
  const typeBarLift = useMemo(() => Animated.multiply(keyboard.lift, -1), [keyboard.lift]);

  // Once the keyboard the field summoned has actually gone (the ×, an app
  // switch, a hardware keyboard), the floating row has nothing to sit above —
  // left open it would park on top of the dock. Close it; the draft survives
  // in `text` for the next open. The ref gates on "a keyboard was seen" so
  // the row is not closed in the gap between mounting and the show event.
  const sawKeyboardRef = useRef(false);
  useEffect(() => {
    if (keyboard.shown) {
      sawKeyboardRef.current = true;
      return;
    }
    if (sawKeyboardRef.current) {
      sawKeyboardRef.current = false;
      setTypeOpen(false);
    }
  }, [keyboard.shown]);

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
        submitBehavior="submit"
        autoFocus
        trailing={
          <IconButton
            testID="type-close"
            accessibilityLabel="Stop typing and hide the keyboard"
            variant="plain"
            onPress={closeType}
          >
            <Txt variant="label" tone="dim">×</Txt>
          </IconButton>
        }
      />
      <Button testID="send-text" label="Send" onPress={sendText} size="sm" />
    </Row>
  );

  // First-run hint: one quiet line pointing at the control bar, shown until
  // it is dismissed or proved unnecessary (the user opens Keys or Tools).
  const hint =
    !immersive && hintSeen === false && Boolean(connection) ? (
      <Row testID="control-bar-hint" justify="space-between" align="center" gap="sm">
        <Caption style={{ flexShrink: 1 }}>
          New here? Keys, and all your tools, live down here.
        </Caption>
        <IconButton
          testID="dismiss-hint"
          accessibilityLabel="Dismiss this hint"
          variant="plain"
          onPress={dismissHint}
        >
          <Txt variant="label" tone="dim">×</Txt>
        </IconButton>
      </Row>
    ) : null;

  const controls = (
    <Column gap="xs">
      {/* The cross-surface "needs you" band, inline so it rides directly on
          top of the control bar wherever that bar happens to be. */}
      <NeedsYouBanner />
      {keysOn ? (
        <KeyBar
          mac={isMac}
          mods={mods}
          onKey={sendKey}
          onRepeat={repeatKey}
          onMod={tapModifier}
          floating={immersive}
          testID="key-bar"
        />
      ) : null}
      {typeOpen && !TYPE_ROW_FLOATS ? typeRow : null}
      {hint}
      <ControlDock
        mode={mode}
        onModeChange={setMode}
        armed={button}
        onToggleRight={() => setButton((b) => (b === 'right' ? 'none' : 'right'))}
        onToggleDouble={() => setButton((b) => (b === 'double' ? 'none' : 'double'))}
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
        recordPhase={recordPhase}
        onRecord={onRecordKey}
        floating={immersive}
        onInteract={fullscreen ? dockHide.poke : undefined}
        onOpenClipboard={() => setShowClipboard(true)}
        keysOn={keysOn}
        onToggleKeys={toggleKeys}
        onOpenTools={openTools}
        toolsBadge={waitingCount > 0 ? waitingCount : null}
      />
    </Column>
  );

  return (
    // A plain root: keyboard handling is the floating type bar's job (see
    // `typeBarLift` above), so the stage and dock never re-flow.
    <View
      ref={rootRef}
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
      <HostAudio enabled={audioOn} connected={active} />

      {!immersive ? (
        <View style={{ paddingHorizontal: theme.layout.margin, paddingTop: theme.space.md, paddingBottom: theme.space.md }}>
          <Row justify="space-between" gap="sm">
            <Txt
              variant="title"
              heading
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              style={{ flexShrink: 1 }}
            >
              {(connection?.hostName || 'Screen').replace(/\.local$/i, '')}
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
          {/* The one status line (§8): the shared link words, with the way
              out trailing. Stream detail lives on the glass and in the HUD —
              the header never restates it. */}
          <ConnectionStatus
            testID="screen-connection"
            phase={linkPhase}
            trailing={<SwitchComputerLink />}
            style={{ marginTop: theme.space.xxs }}
          />
        </View>
      ) : null}

      {/* The recording strip sits above the panel where the eye already goes
          for stream status; while the host's screen is being captured it must
          be impossible to miss, so it never shares a sheet or a toggle. */}
      {!immersive ? (
        <RecordStrip status={recording.status} onStop={stopRecording} onReview={() => setShowRecordSheet(true)} />
      ) : null}
      {!immersive && sent ? <SentNotice info={sent} onOpen={openSentSession} /> : null}
      {!immersive ? noticeArea : null}
      {!immersive ? <Rule /> : null}

      {/* The machine panel: full-bleed, top-aligned under the header rule,
          filling everything down to the dock so the page never jumps between
          the live, waiting and failed states (docs/DESIGN.md §9). */}
      <View
        onLayout={onBoxLayout}
        style={{
          flex: 1,
          backgroundColor: theme.colors.machine,
          alignItems: 'center',
          justifyContent: immersive ? 'center' : 'flex-start',
        }}
      >
        <View
          testID="screen-surface"
          accessibilityLabel="Remote screen. Tap to click, long press to right-click, pinch to zoom, two fingers to scroll, three fingers to switch desktops."
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
            style={{
              pointerEvents: 'none',
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

          {/* Portrait: the Full control rides the stage's own top-right
              corner. Landscape shows nothing here — it is already full. */}
          {!immersive && !permissions.captureBlocked
            ? stageControls({ top: theme.space.xs, right: theme.space.xs })
            : null}
        </View>

        {/* No picture: the panel interior becomes the guidance surface —
            state name, the observed cause, one accent action, proof of life.
            It covers the stage, which has nothing to click anyway. */}
        {showPanelState ? (
          <PanelState
            testID="panel-state"
            connected={Boolean(connection)}
            phase={stream.phase}
            retryingSinceMs={stream.retryingSinceMs}
            streamError={stream.error}
            captureBlocked={permissions.captureBlocked}
            captureKnown={permissions.known}
            hostName={connection?.hostName || 'The computer'}
            onRetry={recheck}
            onHelp={() => setShowHelp(true)}
          />
        ) : null}

        {/* Portrait fullscreen: the Exit control pins to the safe area (not
            the letterboxed stage), always visible, full size, one action.
            Landscape needs no exit — rotating back IS the exit. */}
        {fullscreen && !landscape
          ? stageControls({ top: insets.top + theme.space.xs, right: insets.right + theme.space.xs })
          : null}

        {/* Input errors still matter while immersive; they float over the top edge. */}
        {immersive ? (
          <View
            style={{ pointerEvents: 'box-none', position: 'absolute', top: insets.top + theme.space.xs, left: 0, right: 0 }}
          >
            {/* Recording must stay unmissable in fullscreen too — it floats on
                the HUD scrim over the top edge, outliving the dock's auto-hide. */}
            <View style={{ paddingHorizontal: theme.space.sm, gap: theme.space.xxs }}>
              <RecordStrip
                status={recording.status}
                onStop={stopRecording}
                onReview={() => setShowRecordSheet(true)}
                floating
              />
              {sent ? <SentNotice info={sent} onOpen={openSentSession} floating /> : null}
            </View>
            {noticeArea}
          </View>
        ) : null}
      </View>

      {!immersive ? (
        <View style={{ paddingHorizontal: theme.layout.margin }}>
          <Rule bleed={theme.layout.margin} />
          <View style={{ paddingTop: theme.space.xs, paddingBottom: insets.bottom + theme.space.sm }}>{controls}</View>
        </View>
      ) : (
        <Animated.View
          style={{
            pointerEvents: dockShown ? 'box-none' : 'none',
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

      {/* The type-to-PC row, floating on the keyboard's top edge. Absolute so
          opening it moves NOTHING else: the stage keeps its size (the keyboard
          simply covers its lower part) and the dock stays where the thumb
          left it, ready the moment the field is closed. */}
      {typeOpen && TYPE_ROW_FLOATS ? (
        <Animated.View
          testID="type-bar"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            transform: [{ translateY: typeBarLift }],
            // Opaque page ground normally; the HUD scrim over live video
            // while immersive, matching the floating dock's chrome.
            backgroundColor: immersive ? HUD.scrim : theme.colors.bg,
            borderTopWidth: theme.layout.hairline,
            borderTopColor: immersive ? HUD.hairline : theme.colors.border,
            paddingHorizontal: theme.layout.margin,
            paddingVertical: theme.space.xs,
          }}
        >
          {typeRow}
        </Animated.View>
      ) : null}

      {/* Gated on `ready`, not just the flag: a stop that failed leaves
          nothing to send, and a sheet promising to send nothing would lie. */}
      <RecordSheet
        visible={showRecordSheet && recordPhase === 'ready'}
        onClose={() => setShowRecordSheet(false)}
        status={recording.status}
        busy={recording.busy}
        onSend={recording.send}
        onDiscard={() => void recording.discard()}
        onSent={onSent}
      />

      <ClipboardSheet visible={showClipboard} onClose={() => setShowClipboard(false)} />

      {/* The tool drawer: the four former tabs, named and explained, each
          opening as a slide-up panel over this desktop. */}
      <ToolDrawer visible={showTools} onClose={() => setShowTools(false)} waitingCount={waitingCount} />

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
            testID="toggle-audio"
            title="Host audio"
            subtitle={audioOn ? 'Playing on this phone' : 'Off'}
            selected={audioOn}
            accessibilityHint="Plays the computer's system audio through this phone's speaker"
            onPress={() => setAudioOn((v) => !v)}
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

          {/* True-resolution picker — only when the host advertises the virtual
              display driver. On every other host the physical-downscale path
              above is the whole story, so the section simply does not appear. */}
          {vdAvailable ? (
            <Column gap="xxs" testID="resolution-section">
              <Rule />
              <Txt variant="bodyStrong">Host resolution</Txt>
              {resolutions.map((option) => (
                <ListItem
                  key={option.id}
                  testID={`resolution-${option.id}`}
                  title={option.label}
                  subtitle={option.hint}
                  selected={option.id === resolution.id}
                  onPress={() => setResolutionId(option.id)}
                />
              ))}
              <Caption>
                {resolution.size
                  ? 'The host renders a virtual display at this size and streams it — aspect-matched, no letterbox. Removed when you disconnect or switch back.'
                  : 'Mirroring the real monitor. Pick a size above to have the host render a display shaped to your phone.'}
              </Caption>
            </Column>
          ) : null}
        </Column>
      </Sheet>

      <Sheet visible={showHelp} onClose={() => setShowHelp(false)} title="Controls & permissions" testID="help-sheet">
        <ScrollView style={{ maxHeight: 400 }} contentContainerStyle={{ gap: theme.space.sm }}>
          <Txt variant="bodyStrong">Touch mode</Txt>
          <Caption>
            Tap to click, long press to right-click. At 1× a drag becomes a mouse drag on the PC; once you zoom in, a
            drag pans the picture instead.
          </Caption>
          <Txt variant="bodyStrong">Scroll mode</Txt>
          <Caption>
            One finger scrolls the page under it, the way every other app on the phone does — the content follows your
            finger, and a flick keeps it coasting. Tap still clicks and long press still right-clicks, so you can open
            the link you just scrolled to without leaving the mode.
          </Caption>
          <Txt variant="bodyStrong">Trackpad mode</Txt>
          <Caption>
            Drag anywhere to nudge the cursor — it stays visible instead of hiding under your finger, which is the only
            way to hit small targets. Tap to click where the cursor sits.
          </Caption>
          <Txt variant="bodyStrong">All modes</Txt>
          <Caption>
            Pinch to zoom, two-finger drag to scroll. The right-click and double-click controls in the dock arm the next
            tap only. Swipe three fingers left or right to switch to the next or previous desktop, or three fingers up
            for Mission Control / Task View — the Desk keys on the key bar's last page do the same by touch.
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
    </View>
  );
}
