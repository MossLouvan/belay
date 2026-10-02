// "Allow <phone>?" — a phone on this account asked to join the connected
// computer (account trust, server/src/account-pair.ts) and waits for one tap.
// Shown in the needs-you band on every tab and on the computer list; Belay.app
// on the computer shows the same request, and whichever answers first wins.

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Button, Dot, Row, Txt, haptic } from '../ui';
import { answerPairRequest, useAgentAttention } from '../agent/attention-store';
import { livePairRequests } from '../agent/pair-requests';
import type { PairRequestRow } from '../agent/pair-requests';

/** "An iPhone added to your account on 2 Oct." — what the account knows about it. */
function describePhone(r: PairRequestRow): string {
  const kind = r.platform === 'ios' ? 'An iPhone' : r.platform === 'android' ? 'An Android phone' : 'A phone';
  const when = r.addedAt ? ` added to your account on ${new Date(r.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ' on your account';
  return `${kind}${when} wants to use this computer.`;
}

export function PairRequestCards() {
  const theme = useTheme();
  const { pairRequests } = useAgentAttention();
  const [now, setNow] = useState(() => Date.now());

  // Re-check expiry while anything is waiting; the host only sweeps on change.
  useEffect(() => {
    if (pairRequests.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [pairRequests.length]);

  const live = livePairRequests(pairRequests, now);
  if (live.length === 0) return null;
  return (
    <View testID="pair-requests" accessibilityLiveRegion="polite">
      {live.map((r) => (
        <View
          key={r.id}
          testID={`pair-request-${r.id}`}
          style={{
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
            <View style={{ flex: 1, gap: 2 }}>
              <Row gap="xs">
                <Dot status="warn" size={7} />
                <Txt variant="label" tone="dim">Needs you</Txt>
              </Row>
              <Txt variant="body" numberOfLines={1}>{`Allow ${r.name}?`}</Txt>
              <Txt variant="caption" tone="dim" numberOfLines={2}>
                {`${describePhone(r)} Allow it only if it is yours${r.matchCode ? ' and it shows this code' : ''}.`}
              </Txt>
              {r.matchCode ? (
                <Txt variant="mono" testID={`pair-request-code-${r.id}`} style={{ letterSpacing: 4 }}>{r.matchCode}</Txt>
              ) : null}
            </View>
            <Button
              testID={`pair-request-deny-${r.id}`} label="Deny" size="sm" variant="ghost"
              accessibilityLabel={`Deny ${r.name}`}
              onPress={() => { haptic('light'); void answerPairRequest(r.id, false); }}
            />
            <Button
              testID={`pair-request-allow-${r.id}`} label="Allow" size="sm"
              accessibilityLabel={`Allow ${r.name} to use this computer`}
              onPress={() => { haptic('success'); void answerPairRequest(r.id, true); }}
            />
          </Row>
        </View>
      ))}
    </View>
  );
}
