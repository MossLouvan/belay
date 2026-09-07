// The Controls & permissions sheet: the gesture vocabulary, the key bar,
// the modifiers, and the macOS grants the host needs. Static copy plus one
// action — recheck the host. Presentational.

import React from 'react';
import { ScrollView } from 'react-native';
import { useTheme } from '../theme';
import { Button, Caption, Sheet, Txt } from '../ui';
import { LAUNCHER_NOTE, MAC_STEPS } from './model';

export interface HelpSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Re-poll the host's info and retry the stream. */
  readonly onRecheck: () => void;
}

export function HelpSheet({ visible, onClose, onRecheck }: HelpSheetProps) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="Controls & permissions" testID="help-sheet">
      <ScrollView style={{ maxHeight: 400 }} contentContainerStyle={{ gap: theme.space.sm }} bounces={false}>
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
          Pinch to zoom, two-finger drag to scroll, and a quick two-finger tap right-clicks — the Mac trackpad's
          secondary click. Double-tap for a real double-click. The right-click and double-click controls in the dock
          arm the next tap only.
        </Caption>
        <Txt variant="bodyStrong">Multi-finger gestures</Txt>
        <Caption>
          Swipe three fingers left or right to switch desktops, three up for Mission Control / Task View, or three down
          to show windows of the current app (macOS only). On Windows, two-finger swipe from the top edge opens Action
          Center. These match your computer's native trackpad gestures — the Desk keys on the key bar's last page do
          the same by touch.
        </Caption>
        <Txt variant="bodyStrong">The black gap is a trackpad</Txt>
        <Caption>
          The space between the picture and the control bar is a laptop trackpad, whatever mode is on: drag to move
          the pointer, tap to click it, two fingers to scroll. In landscape the control bar tucks away after a few
          seconds — swipe up from the very bottom edge of the screen to bring it back.
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
        <Button label="Recheck the host" testID="recheck-permissions" variant="secondary" size="sm" onPress={onRecheck} />
      </ScrollView>
    </Sheet>
  );
}
