// Touch · Pad · Keyboard (· Controller) — the portrait dock's primary control, and
// the loudest thing on the desktop screen after the picture itself.
//
// Drawn from both mockups: a recessed bordered track with three equal
// segments, the selected one filled and rounded one step tighter than the
// track. Where they differ is the fill. Current uses the solid accent with
// white ink — the blue chip is that concept's signature. Fieldwork uses the
// muted `accentSoft` scorch with orange ink, because a solid orange chip on a
// near-black page is a flare, not a selection. `look.segmentSoft` is the
// switch; nothing else about the strip changes.
//
// Exclusive choices (Touch ↔ Pad is one tap, #130), so each segment carries `accessibilityRole="tab"`
// with a selected state rather than an unlabelled button.

import React from 'react';
import { Pressable, View } from 'react-native';
import { IconDeviceGamepad2, IconHandFinger, IconKeyboard, IconPointer } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { Txt, tabSelected } from '../ui';
import { LABS } from '../labs';
import { stripSelection } from './dock-modes';
import type { ScreenMode, StripId } from './dock-modes';

const SEGMENTS: readonly { id: StripId; testID: string; label: string; Glyph: typeof IconPointer }[] = [
  { id: 'touch', testID: 'dock-touch', label: 'Touch', Glyph: IconHandFinger },
  { id: 'trackpad', testID: 'dock-trackpad', label: 'Pad', Glyph: IconPointer },
  { id: 'keyboard', testID: 'toggle-type', label: 'Keyboard', Glyph: IconKeyboard },
  { id: 'gaming', testID: 'dock-controller', label: 'Controller', Glyph: IconDeviceGamepad2 },
];

export interface ModeStripProps {
  /** The pointer mode in force — the strip lights it (#130). */
  readonly mode: ScreenMode;
  /** The keyboard sheet is up — Keyboard is the selected segment. */
  readonly typeOpen: boolean;
  readonly onTouch: () => void;
  readonly onTrackpad: () => void;
  readonly onKeyboard: () => void;
  readonly onController: () => void;
}

export function ModeStrip({ mode, typeOpen, onTouch, onTrackpad, onKeyboard, onController }: ModeStripProps) {
  const theme = useTheme();
  const look = useLook();

  const activeFill = look.segmentSoft ? theme.colors.accentSoft : theme.colors.accent;
  const activeInk = look.segmentSoft ? theme.colors.onAccentSoft : theme.colors.onAccent;
  const actions: Readonly<Record<StripId, () => void>> = {
    touch: onTouch,
    trackpad: onTrackpad,
    keyboard: onKeyboard,
    gaming: onController,
  };
  const selected = stripSelection(mode, typeOpen);

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        borderRadius: look.controlRadius + 4,
        padding: 3,
        backgroundColor: theme.colors.surfaceAlt,
        borderWidth: theme.layout.hairline,
        borderColor: theme.colors.border,
      }}
    >
      {SEGMENTS.filter((seg) => LABS || seg.id !== 'gaming').map(({ id, testID, label, Glyph }) => {
        const active = id === selected;
        const ink = active ? activeInk : theme.colors.textDim;
        return (
          <Pressable
            key={id}
            testID={testID}
            accessibilityRole="tab"
            accessibilityLabel={label}
            {...tabSelected(active)}
            onPress={actions[id]}
            style={({ pressed }) => ({
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              minHeight: 34,
              borderRadius: look.controlRadius + 1,
              backgroundColor: active ? activeFill : 'transparent',
              opacity: pressed ? theme.motion.pressOpacity : 1,
            })}
          >
            <Glyph size={18} strokeWidth={2} color={ink} />
            <Txt variant="button" numberOfLines={1} style={{ fontSize: 14, color: active ? activeInk : theme.colors.text }}>
              {label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}
