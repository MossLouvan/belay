// The cross-tab "needs you" band. Whenever any session is blocked on an
// approval, this sits directly above the tab bar on every tab, names the
// session and the tool, shows how long is left before the host gives up, and
// answers inline — Allow / Deny without navigating. Approvals are the
// highest-stakes UI in the app, so the controls are real solid-fill buttons,
// not label text (docs/DESIGN.md §11.5: safety-relevant actions outrank the
// one-accent rule; §11.1: tappable must look tappable).
//
// It stands down in exactly one case: the Agent tab already has this session
// open, where the full approval band (with the expandable tool input) is on
// screen — doubling it there would stack two answer surfaces for one ask.

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { Button, Micro, Row, Txt, haptic } from '../ui';
import { askSummary, countdown, expiryUrgent, waitingSessions } from './attention';
import { answerApproval, setOpenSession, useAgentAttention } from './attention-store';

export function NeedsYouBanner({ bottom }: { bottom: number }) {
  const theme = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const { sessions, openId } = useAgentAttention();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const waiting = waitingSessions(sessions ?? []);
  const primary = waiting[0];
  const deadline = primary?.pending?.expiresAt;

  // The countdown ticks every second only while there is a deadline to count.
  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);

  const open = useCallback(() => {
    if (!primary) return;
    haptic('light');
    setOpenSession(primary.id);
    router.navigate('/agent');
  }, [primary, router]);

  const answer = useCallback((allow: boolean) => {
    if (!primary?.pending || busy) return;
    setBusy(true);
    setFailed(false);
    answerApproval(primary.id, primary.pending.id, allow)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }, [primary, busy]);

  if (!primary) return null;
  // The session view already shows this ask, with the full input.
  if (pathname.includes('agent') && openId === primary.id) return null;

  const left = countdown(deadline, now);
  const urgent = expiryUrgent(deadline, now);

  return (
    <View
      testID="needs-you"
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom,
        paddingHorizontal: theme.layout.margin,
        paddingVertical: theme.space.sm,
        gap: theme.space.xs,
        backgroundColor: theme.colors.warnSoft,
        borderTopWidth: theme.layout.hairline,
        borderTopColor: theme.colors.border,
        borderLeftWidth: theme.layout.ruleEmphasis,
        borderLeftColor: theme.colors.warn,
      }}
    >
      <Pressable
        testID="needs-you-open"
        accessibilityRole="button"
        accessibilityLabel={`${primary.title} needs a decision — open the session`}
        onPress={open}
        style={({ pressed }) => ({ gap: 2, opacity: pressed ? theme.motion.pressOpacity : 1 })}
      >
        <Row justify="space-between" gap="sm">
          <Txt variant="label" color={theme.colors.onWarnSoft}>
            {waiting.length > 1 ? `Needs you · ${waiting.length} waiting` : 'Needs you'}
          </Txt>
          {left ? (
            <Micro tone={urgent ? 'bad' : 'dim'}>{`auto-denies in ${left}`}</Micro>
          ) : null}
        </Row>
        <Txt variant="mono" numberOfLines={1}>
          <Txt variant="mono" tone="accent">{primary.title}</Txt>
          {primary.pending ? `  ${askSummary(primary.pending.tool, primary.pending.detail)}` : ''}
        </Txt>
        {failed ? <Micro tone="bad">could not send the answer — try again or open the session</Micro> : null}
      </Pressable>
      <Row gap="xs">
        <Button
          testID="needs-you-deny"
          label="Deny"
          variant="danger"
          size="sm"
          disabled={busy || !primary.pending}
          onPress={() => answer(false)}
          style={{ flex: 1 }}
        />
        <Button
          testID="needs-you-allow"
          label="Allow"
          size="sm"
          disabled={busy || !primary.pending}
          onPress={() => answer(true)}
          style={{ flex: 1 }}
        />
      </Row>
    </View>
  );
}
