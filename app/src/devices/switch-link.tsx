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
//
// With exactly two computers a second tracked label appears — "⇄ <the other
// one>" — and tapping it switches directly, no list screen in between
// (`quickSwitch` in switch-target.ts owns the when-and-to-where). Naming the
// destination is what lets a session-dropping tap go unconfirmed: you know
// where you will land, and the same tap brings you back. The current-computer
// label keeps opening My Computers, so the full list — managing, forgetting,
// pairing — stays one visible tap from every screen (§11.2: the long-press
// shortcut's twin is the label right beside it). A switch that fails leaves
// the honest `unreachable` phase standing: this very element then reads
// "<target> · unreachable" with the way back sitting next to it, and each
// tab's own guidance surface takes it from there (§11.4).

import React, { useCallback } from 'react';
import { router } from 'expo-router';
import type { StyleProp, ViewStyle } from 'react-native';
import { useConnection } from '../connection';
import { useTheme } from '../theme';
import { Row, TrackLabel } from '../ui';
import { connectionSummary } from './summary';
import { quickSwitch } from './switch-target';

export interface SwitchComputerLinkProps {
  style?: StyleProp<ViewStyle>;
}

/**
 * Tappable "current computer" element for tab headers. Routes to My
 * Computers; with exactly two computers it also carries the one-tap switch.
 */
export function SwitchComputerLink({ style }: SwitchComputerLinkProps) {
  const { active, devices, phase, activeUrl, switchTo } = useConnection();
  const theme = useTheme();
  const summary = connectionSummary(active, phase, activeUrl);
  const quick = quickSwitch(devices, active);
  const targetId = quick?.target.id;

  const onPress = useCallback(() => {
    router.push('/devices');
  }, []);

  const onSwitch = useCallback(() => {
    if (!targetId) return;
    // Mid-connect taps are safe: the context's attempt guard means the newest
    // switch wins, so tapping while the previous one is still racing simply
    // becomes "no, the other one". The outcome lands in `phase`, which this
    // header already narrates — connecting pulses, unreachable stands.
    void switchTo(targetId);
  }, [switchTo, targetId]);

  return (
    <Row gap="xs" style={[{ flexShrink: 1 }, style]}>
      {/* No dot here — the screen's ONE status dot (ConnectionStatus) speaks
          the machine's health; this link is a place, not a status. */}
      <TrackLabel
        testID="switch-computer"
        label={summary.text}
        accessibilityLabel={summary.accessibilityLabel}
        accessibilityHint="Opens My Computers"
        onPress={onPress}
        hitSlop={theme.layout.hitSlop}
        // When both labels cannot fit, the current computer's path gives way
        // first: the destination name is the one that must survive whole for
        // the switch to be predictable before the tap.
        style={{ flexShrink: quick ? 3 : 1 }}
      />
      {quick ? (
        <TrackLabel
          testID="switch-other"
          label={quick.text}
          accessibilityLabel={quick.accessibilityLabel}
          accessibilityHint={quick.accessibilityHint}
          onPress={onSwitch}
          // Shortcut only — the visible route to the list is the label beside
          // this one (§11.2).
          onLongPress={onPress}
          hitSlop={theme.layout.hitSlop}
          // The wider gutter keeps two adjacent tracks reading as two
          // controls rather than one long one.
          style={{ flexShrink: 1, marginLeft: theme.space.xs }}
        />
      ) : null}
    </Row>
  );
}
