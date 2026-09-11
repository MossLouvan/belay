// Trackpad · Keyboard · Controller — the portrait dock's primary control, and
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
// Three exclusive choices, so each segment carries `accessibilityRole="tab"`
// with a selected state rather than an unlabelled button.

import React from 'react';
import { Pressable, View } from 'react-native';
import { IconDeviceGamepad2, IconKeyboard, IconPointer } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { Txt } from '../ui';

type ModeId = 'dock-trackpad' | 'toggle-type' | 'dock-controller';

const GLYPHS = {
  'dock-trackpad': IconPointer,
  'toggle-type': IconKeyboard,
  'dock-controller': IconDeviceGamepad2,
} as const;

const LABELS = {
  'dock-trackpad': 'Trackpad',
  'toggle-type': 'Keyboard',
  'dock-controller': 'Controller',
} as const;

export interface ModeStripProps {
  /** The keyboard sheet is up — Keyboard is the selected segment. */
  readonly typeOpen: boolean;
  readonly onTrackpad: () => void;
  readonly onKeyboard: () => void;
  readonly onController: () => void;
}

export function ModeStrip({ typeOpen, onTrackpad, onKeyboard, onController }: ModeStripProps) {
  const theme = useTheme();
  const look = useLook();

  const activeFill = look.segmentSoft ? theme.colors.accentSoft : theme.colors.accent;
  const activeInk = look.segmentSoft ? theme.colors.onAccentSoft : theme.colors.onAccent;
  const actions: Readonly<Record<ModeId, () => void>> = {
    'dock-trackpad': onTrackpad,
    'toggle-type': onKeyboard,
    'dock-controller': onController,
  };
  const selected: ModeId = typeOpen ? 'toggle-type' : 'dock-trackpad';

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
      {(Object.keys(GLYPHS) as ModeId[]).map((id) => {
        const active = id === selected;
        const Glyph = GLYPHS[id];
        const ink = active ? activeInk : theme.colors.textDim;
        return (
          <Pressable
            key={id}
            testID={id}
            accessibilityRole="tab"
            accessibilityLabel={LABELS[id]}
            accessibilityState={{ selected: active }}
            onPress={actions[id]}
            style={({ pressed }) => ({
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              minHeight: 34,
              borderRadius: look.controlRadius + 1,
              backgroundColor: active ? activeFill : 'transparent',
              opacity: pressed ? theme.motion.pressOpacity : 1,
            })}
          >
            <Glyph size={18} strokeWidth={2} color={ink} />
            <Txt variant="button" numberOfLines={1} style={{ fontSize: 14, color: active ? activeInk : theme.colors.text }}>
              {LABELS[id]}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}
