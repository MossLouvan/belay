// The portrait header over the desktop, drawn two ways.
//
// The concept mockups disagree here on purpose and both are honoured:
//
//   Current   ‹ Computers · ⋯          a back row with the destination named,
//             Moss's PC                then the host as a display-size title,
//             ● Connected              with the link state on its own line.
//
//   Fieldwork ‹   Moss's PC   ⋯        one compact centred bar; the link state
//                 ● Connected          rides under the title inside it.
//
// Landscape and fullscreen show none of this — the immersive HUD carries the
// link state and the orientation latch instead. This header took a
// `mascotLabel`/`onMascotPress` pair for a mascot it never rendered; the props
// are gone rather than left as a control the caller believes exists.

import React from 'react';
import { View } from 'react-native';
import { IconChevronLeft, IconDots } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { Row, Txt } from '../ui';
import { RoundButton } from '../ui/round-button';
import { StatusLine } from './status-line';
import type { ConnectPhase } from '../connection';
import { headerTitle } from './screen-chrome';

export interface ScreenHeaderProps {
  readonly hostName: string | undefined;
  readonly linkPhase: ConnectPhase;
  readonly onBack: () => void;
  readonly onOpenMenu: () => void;
}

export function ScreenHeader({ hostName, linkPhase, onBack, onOpenMenu }: ScreenHeaderProps) {
  const theme = useTheme();
  const look = useLook();
  const title = headerTitle(hostName);

  const back = (
    <RoundButton
      testID="screen-back"
      accessibilityLabel="Back to my computers"
      variant="plain"
      onPress={onBack}
    >
      <IconChevronLeft size={24} strokeWidth={2.2} color={theme.colors.text} />
    </RoundButton>
  );
  const menu = (
    <RoundButton
      testID="screen-menu"
      accessibilityLabel="Screen options"
      variant={look.headerAction === 'add' ? 'filled' : 'outline'}
      onPress={onOpenMenu}
    >
      <IconDots size={20} strokeWidth={2} color={look.headerAction === 'add' ? theme.colors.accent : theme.colors.textDim} />
    </RoundButton>
  );

  if (!look.screenTitleLarge) {
    // Fieldwork: one compact bar, title centred between the two controls.
    return (
      <View style={{ paddingHorizontal: theme.layout.margin, paddingTop: theme.space.xs, paddingBottom: theme.space.sm }}>
        <Row justify="space-between" align="center" gap="sm">
          {back}
          <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
            <Txt variant="subheading" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {title}
            </Txt>
            <StatusLine testID="screen-connection" phase={linkPhase} />
          </View>
          {menu}
        </Row>
      </View>
    );
  }

  // Current: named back row, then the host as the page's display title.
  return (
    <View style={{ paddingHorizontal: theme.layout.margin, paddingTop: theme.space.xs, paddingBottom: theme.space.sm }}>
      <Row justify="space-between" align="center" gap="sm">
        <Row gap="none" align="center" style={{ flexShrink: 1, marginLeft: -8 }}>
          {back}
          <Txt variant="body" numberOfLines={1}>{look.backLabel}</Txt>
        </Row>
        {menu}
      </Row>
      <Txt
        variant="display"
        heading
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        style={{ marginTop: theme.space.xs }}
      >
        {title}
      </Txt>
      <StatusLine testID="screen-connection" phase={linkPhase} style={{ marginTop: 2 }} />
    </View>
  );
}
