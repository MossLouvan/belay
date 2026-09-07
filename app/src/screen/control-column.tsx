// The control column: the "needs you" band, the key bar when Keys is on,
// the inline type row (where it does not float), the first-run hint, and
// the control dock itself. Rendered docked in portrait and floating while
// immersive (floating-dock.tsx); the same column either way.

import React from 'react';
import type { ReactNode } from 'react';
import { NeedsYouBanner } from '../agent/needs-you-banner';
import { Column } from '../ui';
import { ControlDock } from './dock';
import type { ScreenMode } from './dock-modes';
import { ControlHint } from './control-hint';
import { GESTURE } from './model';
import { KeyBar } from './parts';
import type { RecordPhase } from './record';
import { agentBadge } from './screen-chrome';
import type { DockState } from './use-dock-state';
import type { KeySender } from './use-key-sender';
import type { MonitorChoiceState } from './use-monitor-choice';
import type { ToolsHint } from './use-tools-hint';
import type { Viewport } from './viewport';

export interface ControlColumnProps {
  readonly isMac: boolean;
  readonly immersive: boolean;
  readonly keys: KeySender;
  readonly dock: DockState;
  readonly monitors: MonitorChoiceState;
  readonly viewport: Viewport;
  readonly tools: ToolsHint;
  /** Whether the first-run hint line shows (screen-chrome.ts hintVisible). */
  readonly hint: boolean;
  /** The inline type row, or null while closed or floating elsewhere. */
  readonly typeRow: ReactNode;
  readonly typeOpen: boolean;
  readonly onToggleType: () => void;
  /** Selecting the Gaming mode opens its sheet instead of switching. */
  readonly onOpenGaming: () => void;
  readonly onOpenMonitorPicker: () => void;
  readonly recordPhase: RecordPhase;
  readonly onRecord: () => void;
  readonly onOpenClipboard: () => void;
  readonly onOpenMenu: () => void;
  readonly onBack: () => void;
}

export function ControlColumn(props: ControlColumnProps) {
  const {
    isMac, immersive, keys, dock, monitors, viewport, tools, hint, typeRow, typeOpen, onToggleType,
    onOpenGaming, onOpenMonitorPicker, recordPhase, onRecord, onOpenClipboard, onOpenMenu, onBack,
  } = props;
  const onModeChange = (next: ScreenMode) => (next === 'gaming' ? onOpenGaming() : dock.setMode(next));
  return (
    <Column gap="sm">
      {/* The cross-surface "needs you" band, inline so it rides directly on
          top of the control bar wherever that bar happens to be. */}
      <NeedsYouBanner />
      {dock.keysOn ? (
        <KeyBar
          mac={isMac}
          mods={keys.mods}
          onKey={keys.sendKey}
          onRepeat={keys.repeatKey}
          onMod={keys.tapModifier}
          floating={immersive}
          testID="key-bar"
        />
      ) : null}
      {typeRow}
      {hint ? <ControlHint onDismiss={tools.dismissHint} /> : null}
      <ControlDock
        mode={dock.mode}
        onModeChange={onModeChange}
        armed={dock.button}
        onToggleRight={dock.toggleRight}
        onToggleDouble={dock.toggleDouble}
        typeOpen={typeOpen}
        onToggleType={onToggleType}
        screens={monitors.screens}
        selectedScreen={monitors.screenIndex}
        onCycleMonitor={monitors.cycleMonitor}
        onOpenMonitorPicker={onOpenMonitorPicker}
        zoom={viewport.zoom}
        onZoomIn={() => viewport.zoomBy(GESTURE.zoomStep)}
        onZoomOut={() => viewport.zoomBy(1 / GESTURE.zoomStep)}
        onZoomReset={viewport.reset}
        recordPhase={recordPhase}
        onRecord={onRecord}
        floating={immersive}
        onInteract={immersive ? dock.dockHide.poke : undefined}
        onOpenClipboard={onOpenClipboard}
        keysOn={dock.keysOn}
        onToggleKeys={dock.toggleKeys}
        onOpenTools={tools.openTools}
        onOpenAgent={tools.openAgent}
        onOpenMenu={onOpenMenu}
        onBack={onBack}
        agentBadge={agentBadge(tools.waitingCount)}
      />
    </Column>
  );
}
