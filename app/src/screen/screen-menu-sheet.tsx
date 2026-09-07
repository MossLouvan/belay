// The Screen options sheet (the header's ⋯ and the floating dock's Menu
// key) and the monitor picker the dock's long-press opens. Presentational.

import React from 'react';
import { Column, ListItem, Sheet } from '../ui';
import { monitorLabel } from './monitors';
import type { MonitorChoice } from './monitors';
import type { QualityPreset } from './model';
import { performanceSummary } from './screen-chrome';
import type { StreamSettings } from './stream-settings-sheet';

export interface ScreenMenuSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly quality: QualityPreset;
  readonly streamSettings: StreamSettings;
  readonly showHud: boolean;
  readonly audioOn: boolean;
  readonly onOpenQuality: () => void;
  readonly onOpenStreamSettings: () => void;
  readonly onToggleHud: () => void;
  readonly onToggleAudio: () => void;
  readonly onOpenHelp: () => void;
}

export function ScreenMenuSheet({
  visible,
  onClose,
  quality,
  streamSettings,
  showHud,
  audioOn,
  onOpenQuality,
  onOpenStreamSettings,
  onToggleHud,
  onToggleAudio,
  onOpenHelp,
}: ScreenMenuSheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Screen options" testID="screen-menu-sheet">
      <Column gap="xxs">
        <ListItem
          testID="quality"
          title="Stream quality"
          subtitle={quality.label}
          onPress={onOpenQuality}
        />
        <ListItem
          testID="stream-settings"
          title="Performance settings"
          subtitle={performanceSummary(streamSettings)}
          onPress={onOpenStreamSettings}
        />
        <ListItem
          testID="toggle-hud"
          title="Connection HUD"
          subtitle={showHud ? 'Shown over the stream' : 'Hidden'}
          selected={showHud}
          accessibilityHint="Toggles the fps, bitrate and ping overlay"
          onPress={onToggleHud}
        />
        <ListItem
          testID="toggle-audio"
          title="Host audio"
          subtitle={audioOn ? 'Playing on this phone' : 'Off'}
          selected={audioOn}
          accessibilityHint="Plays the computer's system audio through this phone's speaker"
          onPress={onToggleAudio}
        />
        <ListItem
          testID="screen-help"
          title="Controls & permissions"
          subtitle="Gestures, right-click, macOS grants"
          onPress={onOpenHelp}
        />
      </Column>
    </Sheet>
  );
}

export interface MonitorSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly screens: readonly MonitorChoice[];
  readonly screenIndex: number | undefined;
  /** Picks a monitor; the sheet closes itself after. */
  readonly onSelect: (index: number) => void;
}

export function MonitorSheet({ visible, onClose, screens, screenIndex, onSelect }: MonitorSheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Monitor" testID="monitor-sheet">
      <Column gap="xxs">
        {screens.map((screen) => (
          <ListItem
            key={screen.index}
            testID={`monitor-${screen.index}`}
            title={`Monitor ${monitorLabel(screen)}`}
            subtitle={screen.w > 0 ? `${screen.w}×${screen.h}` : undefined}
            selected={screen.index === screenIndex}
            onPress={() => {
              onSelect(screen.index);
              onClose();
            }}
          />
        ))}
      </Column>
    </Sheet>
  );
}
