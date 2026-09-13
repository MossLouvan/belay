// The computers list's masthead: the wordmark and the round controls in the
// trailing corner.
//
// The wordmark stands alone. A beluga mark used to sit beside it at 26pt and
// it did not survive the size: with no room for the melon — the domed forehead
// that is the animal's only unmistakable feature — the silhouette collapsed
// into a generic small fish, which is a worse answer than no mark at all. The
// mark still exists, but only where it is drawn large enough to be itself (the
// first-run welcome hero); up here the word does the work.
//
// Both mockups draw one round 36pt button up there — a filled `+` in Current,
// an outlined `⋯` in Fieldwork — and they mean different things, so both are
// real here rather than one glyph pretending to do two jobs. Current keeps a
// second, quieter `⋯` beside its `+`: the mockup has no way at all to reach
// Appearance from this screen, and a settings surface you cannot open is not a
// design decision, it is a missing control.

import React from 'react';
import { IconDots, IconPlus } from '@tabler/icons-react-native';
import { Row, Txt } from '../ui';
import { RoundButton } from '../ui/round-button';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';

export interface DevicesHeaderProps {
  readonly onAdd: () => void;
  readonly onOpenOptions: () => void;
}

export function DevicesHeader({ onAdd, onOpenOptions }: DevicesHeaderProps) {
  const theme = useTheme();
  const look = useLook();
  const showAdd = look.headerAction === 'add';

  return (
    <Row justify="space-between" align="center">
      <Txt
        heading
        style={{ ...theme.type.display, fontSize: 24, lineHeight: 29, letterSpacing: -0.9 }}
      >
        belay
      </Txt>
      <Row gap="xs" align="center">
        <RoundButton
          testID="choose-appearance"
          accessibilityLabel="Options"
          variant={showAdd ? 'plain' : 'outline'}
          onPress={onOpenOptions}
        >
          <IconDots size={20} strokeWidth={2} color={theme.colors.textDim} />
        </RoundButton>
        {showAdd ? (
          <RoundButton testID="header-add-computer" accessibilityLabel="Add computer" variant="filled" onPress={onAdd}>
            <IconPlus size={20} strokeWidth={2.2} color={theme.colors.accent} />
          </RoundButton>
        ) : null}
      </Row>
    </Row>
  );
}
