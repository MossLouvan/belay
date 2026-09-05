// The cross-surface "needs you" band. Whenever any session is blocked on an
// approval, this sits at the bottom of every surface — inline above the
// desktop's control bar, floating over each tool panel's bottom edge — names
// the session and the tool, and shows how long is left before the host gives
// up.
//
// Swept to the Next Terminal register: a quiet navy surface with a hairline
// top edge, a 2pt amber left edge and a small amber dot — never a saturated
// fill — and exactly ONE blue primary action: Review, which opens the session
// where the full approval band (risk, tool input, scope choices) makes the
// Allow/Deny call properly. The approval itself is too high-stakes to answer
// from a strip that cannot show what is being approved.
//
// It stands down in exactly one case: the Agent tab already has this session
// open, where that full approval band is on screen — doubling it there would
// stack two answer surfaces for one ask.

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { Button, Dot, Micro, Row, Txt, haptic } from '../ui';
import { askSummary, countdown, expiryUrgent, waitingSessions } from './attention';
import { setOpenSession, useAgentAttention } from './attention-store';

export interface NeedsYouBannerProps {
  /**
   * Absolute offset from its parent's bottom edge. Omit to render the band
   * in normal flow instead — the desktop home lays it inline directly above
   * the control bar (whose height moves with the key bar), while the tool
   * panels float it over their own bottom edge.
   */
  bottom?: number;
}

export function NeedsYouBanner({ bottom }: NeedsYouBannerProps) {
  const theme = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const { sessions, openId } = useAgentAttention();
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
        ...(bottom === undefined
          ? null
          : { position: 'absolute' as const, left: 0, right: 0, bottom, zIndex: 2 }),
        paddingHorizontal: theme.layout.margin,
        paddingVertical: theme.space.sm,
        gap: theme.space.xs,
        backgroundColor: theme.colors.surface,
        borderTopWidth: theme.layout.hairline,
        borderTopColor: theme.colors.border,
        borderLeftWidth: theme.layout.ruleEmphasis,
        borderLeftColor: theme.colors.warn,
      }}
    >
      <Row gap="sm" align="center">
        <Pressable
          testID="needs-you-open"
          accessibilityRole="button"
          accessibilityLabel={`${primary.title} needs a decision — open the session`}
          onPress={open}
          style={({ pressed }) => ({ flex: 1, gap: 2, opacity: pressed ? theme.motion.pressOpacity : 1 })}
        >
          <Row gap="xs">
            <Dot status="warn" size={7} />
            <Txt variant="label" tone="dim" style={{ flexShrink: 1 }} numberOfLines={1}>
              {waiting.length > 1 ? `Needs you · ${waiting.length} waiting` : 'Needs you'}
            </Txt>
            {left ? (
              <Micro tone={urgent ? 'bad' : 'faint'}>{`auto-denies in ${left}`}</Micro>
            ) : null}
          </Row>
          <Txt variant="mono" numberOfLines={1}>
            <Txt variant="mono" tone="dim">{primary.title}</Txt>
            {primary.pending ? `  ${askSummary(primary.pending.tool, primary.pending.detail)}` : ''}
          </Txt>
        </Pressable>
        {/* The one primary on this surface — blue, because it is the action. */}
        <Button testID="needs-you-review" label="Review" size="sm" onPress={open} />
      </Row>
    </View>
  );
}
