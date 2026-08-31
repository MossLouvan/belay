// The way out of a tab: every header's status line ends with this — which
// computer the screen is controlling, by what path, tap to change it.
//
// It lives inside the existing header anatomy (title, status line, rule —
// docs/DESIGN.md §8) rather than as a persistent strip above the tabs: a
// global bar would spend vertical space on every screen forever and add a
// second chrome layer the redesign just removed, while the status line
// already is the header's "state of this surface" slot. Per §11.1 the text
// carries the resting track — a bare "MACBOOK · LAN" would be indistinguishable
// from the inert status words beside it, which is exactly the
// looks-like-a-label bug this element must not reintroduce.

import React, { useCallback } from 'react';
import { router } from 'expo-router';
import type { StyleProp, ViewStyle } from 'react-native';
import { useConnection } from '../connection';
import { useTheme } from '../theme';
import { Dot, Row, TrackLabel } from '../ui';
import { connectionSummary } from './summary';

export interface SwitchComputerLinkProps {
  style?: StyleProp<ViewStyle>;
}

/** Tappable "current computer" element for tab headers. Routes to My Computers. */
export function SwitchComputerLink({ style }: SwitchComputerLinkProps) {
  const { active, phase, activeUrl } = useConnection();
  const theme = useTheme();
  const summary = connectionSummary(active, phase, activeUrl);

  const onPress = useCallback(() => {
    router.push('/devices');
  }, []);

  return (
    <Row gap="xs" style={[{ flexShrink: 1 }, style]}>
      {/* The dot restates the summary's status for a glance; the label speaks
          for both, so the dot stays silent to assistive tech. */}
      <Dot status={summary.status} pulse={summary.pulse} />
      <TrackLabel
        testID="switch-computer"
        label={summary.text}
        accessibilityLabel={summary.accessibilityLabel}
        accessibilityHint="Opens My Computers"
        onPress={onPress}
        hitSlop={theme.layout.hitSlop}
        style={{ flexShrink: 1 }}
      />
    </Row>
  );
}
