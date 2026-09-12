// The machine panel: full-bleed, top-aligned under the header rule, filling
// everything down to the dock so the page never jumps between the live,
// waiting and failed states (docs/DESIGN.md §9). Inside it, the stage — the
// picture sized to the remote aspect ratio so touch coordinates map straight
// through — the deadspace trackpad behind it, the HUD readout, the Full/Exit
// control, and the panel-state guidance while there is no picture.
//
// Presentational: every decision is made in the route or in screen-chrome.ts.

import React from 'react';
import { Animated, Image, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BelayStreamView } from '../../modules/belay-stream/src';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { StageActions } from './stage-actions';
import { RemoteCursors } from './cursors-overlay';
import type { CursorsState } from './cursors-store';
import type { QualityPreset, Size } from './model';
import { PanelState } from './panel-state';
import { Crosshair, FILL, FullscreenGlyph, HUD, StageButton, StreamHud } from './parts';
import { crosshairShown } from './screen-chrome';
import type { PermissionState, StreamState } from './stream';
import { TrackpadSurface } from './trackpad-surface';
import type { PointerMode, Viewport } from './viewport';

export interface StageViewProps {
  readonly onBoxLayout: (event: LayoutChangeEvent) => void;
  /** The panel's measured size, and the stage fitted into it. */
  readonly box: Size;
  readonly stage: Size;
  /** How far down the immersive stage sits — screen-chrome's immersiveStageOffset. */
  readonly stageOffset: number;
  readonly aspect: number;
  readonly viewport: Viewport;
  readonly stream: StreamState;
  readonly room: CursorsState;
  readonly screenIndex: number | undefined;
  readonly quality: QualityPreset;
  readonly pingMs: number | null;
  readonly permissions: PermissionState;
  readonly mode: PointerMode;
  /** The deadspace pad drove the cursor a moment ago: show the crosshair. */
  readonly padCursor: boolean;
  readonly showHud: boolean;
  readonly showPanelState: boolean;
  readonly gamingEnabled: boolean;
  readonly immersive: boolean;
  readonly fullscreen: boolean;
  readonly landscape: boolean;
  readonly connected: boolean;
  readonly hostName: string;
  readonly onRetry: () => void;
  readonly onHelp: () => void;
  readonly onToggleFullscreen: () => void;
  readonly audioOn?: boolean;
  readonly audioLabel?: string;
  readonly onToggleAudio: () => void;
  /** The immersive HUD overlay, floated over the panel's top edge. */
  readonly children?: ReactNode;
}

export function StageView(props: StageViewProps) {
  const {
    onBoxLayout, box, stage, stageOffset, aspect, viewport, stream, room, screenIndex, quality, pingMs, permissions,
    mode, padCursor, showHud, showPanelState, gamingEnabled, immersive, fullscreen, landscape,
    connected, hostName, onRetry, onHelp, onToggleFullscreen, children,
  } = props;
  const theme = useTheme();
  const look = useLook();
  const insets = useSafeAreaInsets();

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
        onPress={onToggleFullscreen}
      />
    </View>
  );

  const hasPicture = Boolean(stream.bwp || stream.frameUri);

  return (
    // ALWAYS flex-start (top-aligned) — centering the PANEL creates black
    // space above a short stage, which is the "tap → screen on bottom half"
    // bug: the chrome layout hangs the Audio/Fullscreen pills and the pad off
    // `stage.h` measured from the panel's top edge. Immersive has no such
    // siblings (both are FILL), and there a stage shorter than the safe area
    // is nudged down by `stageOffset` — the margin below, not a justify — so
    // a letterboxed portrait picture is centered in view instead of pinned
    // under the status bar. Landscape's edge-to-edge stage offsets by zero.
    <View
      onLayout={onBoxLayout}
      style={{
        flex: 1,
        backgroundColor: immersive ? theme.colors.machine : theme.colors.bg,
        marginHorizontal: immersive ? 0 : theme.layout.margin,
        alignItems: 'center',
        justifyContent: 'flex-start',
      }}
    >
      {/* The deadspace trackpad: fills the whole panel BEHIND the stage, so
          every touch the letterboxed picture does not claim — the black gap
          between stream and control bar above all — is a laptop trackpad
          instead of a hole gestures fall through to the navigation. Mounted
          only while there is a live picture: with the panel-state guidance
          up there is nothing to point at. */}
      {!showPanelState && !gamingEnabled ? (
        <TrackpadSurface
          testID="trackpad-surface"
          handlers={viewport.padHandlers}
          boxH={box.h}
          stageH={stage.h}
          immersive={immersive}
        />
      ) : null}
      <View
        testID="screen-surface"
        accessibilityLabel="Remote screen. Tap to click, long press or two-finger tap to right-click, pinch to zoom, two fingers to scroll, three fingers to switch desktops or access system controls."
        {...(gamingEnabled ? {} : viewport.handlers)}
        style={{
          marginTop: stageOffset,
          width: stage.w > 0 ? stage.w : '100%',
          height: stage.h > 0 ? stage.h : undefined,
          aspectRatio: stage.h > 0 ? undefined : aspect,
          backgroundColor: theme.colors.machine,
          borderRadius: immersive ? 0 : look.cardRadius,
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
            transform: gamingEnabled ? [] : [
              { translateX: viewport.translateX },
              { translateY: viewport.translateY },
              { scale: viewport.scale },
            ],
          }}
        >
          {/* Two video paths, never both. When the host is streaming H.264
              over UDP the native view owns the picture and `frameUri` holds
              whatever the last JPEG frame was — which is stale by definition,
              because the host stopped sending them. */}
          {stream.bwp && BelayStreamView ? (
            <BelayStreamView
              source={stream.bwp}
              onStatus={(e) => stream.onBwpStatus(e.nativeEvent)}
              style={{ width: '100%', height: '100%' }}
            />
          ) : stream.frameUri ? (
            <Image
              source={{ uri: stream.frameUri }}
              accessibilityIgnoresInvertColors
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
          ) : null}
          {crosshairShown({ gaming: gamingEnabled, mode, padCursor, hasPicture }) ? (
            <Crosshair x={viewport.cursorX} y={viewport.cursorY} color={theme.colors.accent} />
          ) : null}
          {/* Collaborators' cursors ride INSIDE the zoom transform, so a
              remote pointer stays on the pixel it is pointing at however far
              this user has zoomed in. */}
          {!gamingEnabled && stream.frameUri ? (
            <RemoteCursors
              cursors={room.cursors}
              selfId={room.selfId}
              width={stage.w}
              height={stage.h}
              surface={{ screen: screenIndex }}
            />
          ) : null}
        </Animated.View>

        {showHud && !gamingEnabled ? (
          <StreamHud
            stats={stream.stats}
            pingMs={pingMs}
            quality={quality}
            zoom={viewport.zoom}
            bwp={stream.bwpStats}
            bwpSize={stream.bwp ? { width: stream.bwpWidth, height: stream.bwpHeight } : null}
            bwpPath={stream.bwpPath}
            bwpClient={stream.bwpClient}
            bwpFallback={stream.bwpFallback}
            /* Clear of the notch already once the stage has been nudged down. */
            topInset={immersive && stageOffset <= 0 ? insets.top : 0}
          />
        ) : null}

        {/* Portrait: the Full control rides the stage's own top-right
            corner. Landscape shows nothing here — it is already full. */}
      </View>
      {!immersive ? (
        <View style={{ position: 'absolute', top: stage.h + 12, left: 0, right: 0 }}>
          <StageActions
            audioOn={props.audioOn ?? false}
            audioLabel={props.audioLabel ?? (props.audioOn ? 'Audio on' : 'Audio off')}
            onToggleAudio={props.onToggleAudio}
            onToggleFullscreen={onToggleFullscreen}
          />
        </View>
      ) : null}

      {/* No picture: the panel interior becomes the guidance surface —
          state name, the observed cause, one accent action, proof of life.
          It covers the stage, which has nothing to click anyway. */}
      {showPanelState ? (
        // Portrait keeps the guidance INSIDE the stage rectangle. Left to fill
        // the whole panel it painted straight over the Audio/Fullscreen pills
        // and the trackpad — the controls that are still useful while there is
        // no picture — so the panel state is clipped to the thing it explains.
        <View
          pointerEvents="box-none"
          style={immersive ? FILL : {
            position: 'absolute', top: 0, left: 0, right: 0,
            height: stage.h > 0 ? stage.h : undefined,
            aspectRatio: stage.h > 0 ? undefined : aspect,
            borderRadius: look.cardRadius, overflow: 'hidden', zIndex: 1,
          }}
        >
        <PanelState
          testID="panel-state"
          connected={connected}
          phase={stream.phase}
          retryingSinceMs={stream.retryingSinceMs}
          streamError={stream.error}
          captureBlocked={permissions.captureBlocked}
          captureKnown={permissions.known}
          hostName={hostName}
          onRetry={onRetry}
          onHelp={onHelp}
        />
        </View>
      ) : null}

      {/* Portrait fullscreen: the Exit control pins to the safe area (not
          the letterboxed stage), always visible, full size, one action.
          Landscape needs no exit — rotating back IS the exit. */}
      {!gamingEnabled && fullscreen && !landscape
        ? stageControls({ top: insets.top + theme.space.xs, right: insets.right + theme.space.xs, zIndex: 4 })
        : null}

      {children}
    </View>
  );
}
