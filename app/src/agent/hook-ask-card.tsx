// A terminal session's permission ask, on the Agent tab's list. The card
// itself is the same ApprovalCard a Belay-spawned session gets — same diff,
// same risk temperature, same Allow / Deny / "Always allow…" — so the phone
// never trains two reflexes. What differs is the frame: a "terminal" tag and
// the project the session runs in, because this ask did not come from a
// session Belay started, and the way the deadline reads: when the hook stops
// waiting, the terminal prompt takes over — nothing is denied.
//
// Tapping the header opens the live transcript read-only, the same view the
// "On this PC" list uses, so you can read what led here before answering.

import React from 'react';
import { Pressable, View } from 'react-native';
import type { HookPermission } from '../api';
import { useTheme } from '../theme';
import { Micro, Row, Txt, haptic } from '../ui';
import { ApprovalCard } from './approval-card';
import { hookTitle } from './hook-model';

/** The deadline's meaning on a terminal ask — see the file comment. */
export const HOOK_EXPIRY_LABEL = 'back to the terminal in';

export interface HookAskCardProps {
  readonly item: HookPermission;
  readonly now: number;
  /** Other terminal asks queued behind this one. */
  readonly stackedCount: number;
  readonly onAnswer: (allow: boolean, choiceId?: string) => void;
  /** Open the session's live transcript. */
  readonly onOpen: () => void;
}

export function HookAskCard({ item, now, stackedCount, onAnswer, onOpen }: HookAskCardProps) {
  const theme = useTheme();
  const title = hookTitle(item);
  return (
    <View testID={`agent-hook-${item.id}`} style={{ gap: theme.space.xs }}>
      <Pressable
        testID={`agent-hook-open-${item.id}`}
        accessibilityRole="button"
        accessibilityLabel={`Terminal session in ${title} — open the transcript`}
        onPress={() => {
          haptic('light');
          onOpen();
        }}
        style={({ pressed }) => ({ opacity: pressed ? theme.motion.pressOpacity : 1 })}
      >
        <Row justify="space-between" gap="sm">
          <Row gap="xs" style={{ flexShrink: 1 }}>
            <Micro testID={`agent-hook-tag-${item.id}`}>TERMINAL</Micro>
            <Txt variant="label" tone="dim" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</Txt>
          </Row>
          <Txt variant="monoSmall" tone="faint" numberOfLines={1} style={{ flexShrink: 1 }}>{item.cwd}</Txt>
        </Row>
      </Pressable>
      <ApprovalCard
        pending={item}
        now={now}
        onAnswer={onAnswer}
        expiryLabel={HOOK_EXPIRY_LABEL}
        stackedCount={stackedCount}
      />
    </View>
  );
}
