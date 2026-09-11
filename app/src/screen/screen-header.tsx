// The portrait header block over the desktop: the leading ‹, the mascot,
// the host's name, the ⋯ menu, and the one status line under them.
// Landscape and fullscreen show none of this — the HUD (immersive-hud.tsx)
// carries the mascot and the connected pill instead.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { BelugaAvatar, ConnectionStatus, IconButton, Row, Txt } from '../ui';
import type { ConnectPhase } from '../connection';
import { SwitchComputerLink } from '../devices/switch-link';
import { DotsGlyph } from './parts';
import { headerTitle } from './screen-chrome';

export interface ScreenHeaderProps {
  readonly hostName: string | undefined;
  readonly linkPhase: ConnectPhase;
  readonly mascotLabel: string;
  readonly onMascotPress: () => void;
  readonly onBack: () => void;
  readonly onOpenMenu: () => void;
}

export function ScreenHeader({ hostName, linkPhase, mascotLabel, onMascotPress, onBack, onOpenMenu }: ScreenHeaderProps) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: theme.layout.margin, paddingTop: theme.space.md, paddingBottom: theme.space.md }}>
      <Row justify="space-between" gap="sm">
        <Row gap="sm" align="center" style={{ flexShrink: 1 }}>
          {/* ‹ alone is sanctioned in this leading corner (docs/DESIGN.md
              §11.1) — the same mark the computers list and the agent
              pages use — and it is the visible twin of the swipe-back
              this route no longer has. It returns to the computers
              list, or the pairing flow when nothing is paired. */}
          <IconButton
            testID="screen-back"
            accessibilityLabel="Back to my computers"
            variant="plain"
            onPress={onBack}
          >
            <Txt variant="title" tone="dim">{'\u2039'}</Txt>
          </IconButton>
          {/* The beluga lives here too — the same mascot the welcome hero
              and the fullscreen HUD carry, so the identity never appears
              and vanishes between states. Its water is the hero ground,
              and its tap is the orientation latch (plus the flip). */}
          <BelugaAvatar
            testID="screen-beluga-avatar"
            size={24}
            backgroundColor={theme.colors.heroBg}
            accessibilityLabel={mascotLabel}
            onPress={onMascotPress}
          />
          <Txt
            variant="heading"
            heading
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
            style={{ flexShrink: 1 }}
          >
            {headerTitle(hostName)}
          </Txt>
        </Row>
        <IconButton
          testID="screen-menu"
          accessibilityLabel="Screen options"
          variant="plain"
          onPress={onOpenMenu}
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
        style={{ marginTop: theme.space.xxs }}
      />
    </View>
  );
}
