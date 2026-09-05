// The approval card — the highest-stakes surface in the app. It used to show
// the tool name and raw JSON, which meant approving a change you could not
// read; that trains a reflex, and the reflex is what makes an approval
// system worthless. Now an Edit renders as a real diff, a Write as its full
// content with a loud line when it replaces a file that exists, and a Bash
// command stands in plain mono — always visible, never behind a toggle.
//
// Risk decides the temperature: ordinary asks keep the page's warn-soft band
// (docs/DESIGN.md §8), danger-tier asks take the bad band, offer no "always",
// and make Allow a deliberate hold instead of a tap — safety marks outrank
// the one-accent rule (§11.5). "Always allow…" lists only the scope choices
// the host offered, each labelled with exactly what it will permit: the
// label is the contract, and tapping it grants that and nothing wider.

import React, { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';
import type { PendingApproval } from '../api';
import { useTheme } from '../theme';
import { Button, Micro, Row, TrackLabel, Txt, haptic } from '../ui';
import { DiffBody } from '../changes/diff-body';
import { editDiff, writeDiff } from '../changes/diff-format';
import { alwaysSectionLabel, approvalHeading, isDanger, previewPath, renderApproval } from './approval-model';
import { getApprovalsWaiting, subscribeApprovalsWaiting, waitingLabel } from './approval-queue';
import { countdown, expiryUrgent } from './attention';

/** Tallest the diff / content panel may stand before it scrolls in place. */
const PREVIEW_MAX_HEIGHT = 260;
/** How long danger-tier Allow must be held. Long enough to be a decision. */
const HOLD_TO_ALLOW_MS = 650;

const GEN = { editDiff, writeDiff };

/**
 * Allow for danger-tier asks: a hold, not a tap. Deliberately NOT easier to
 * miss than Deny — a slipped finger does nothing at all, it neither allows
 * nor denies — and the label teaches the gesture instead of assuming it.
 */
function HoldAllowButton({ onAllow, testID }: { onAllow: () => void; testID: string }) {
  const theme = useTheme();
  const [held, setHeld] = useState(false);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Hold to allow"
      accessibilityHint="Press and hold to allow this risky action"
      delayLongPress={HOLD_TO_ALLOW_MS}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onLongPress={() => { haptic('warning'); onAllow(); }}
      style={{
        flex: 1,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.xs,
        backgroundColor: theme.colors.accent,
        opacity: held ? theme.motion.pressOpacity : 1,
      }}
    >
      <Text allowFontScaling={false} style={{ ...(theme.type.label as TextStyle), color: theme.colors.onAccent }}>
        {held ? 'KEEP HOLDING…' : 'HOLD TO ALLOW'}
      </Text>
    </Pressable>
  );
}

export interface ApprovalCardProps {
  readonly pending: PendingApproval;
  /** Ticking clock from the session view, so one interval serves the screen. */
  readonly now: number;
  /** Answer the ask; `choiceId` mints the matching scoped grant. */
  readonly onAnswer: (allow: boolean, choiceId?: string) => void;
}

export function ApprovalCard({ pending, now, onAnswer }: ApprovalCardProps) {
  const theme = useTheme();
  const [showInput, setShowInput] = useState(false);
  const [showChoices, setShowChoices] = useState(false);
  // Asks queued behind this one (Claude's parallel tool use). Fed by the
  // session socket via the approval-queue store; the card is its one reader.
  const stacked = useSyncExternalStore(subscribeApprovalsWaiting, getApprovalsWaiting, getApprovalsWaiting);
  const stackLine = waitingLabel(stacked);

  const danger = isDanger(pending.risk);
  const render = renderApproval(pending, GEN);
  const path = previewPath(pending);
  const deadline = pending.expiresAt;
  const band = danger
    ? { bg: theme.colors.badSoft, edge: theme.colors.bad, ink: theme.colors.onBadSoft }
    : { bg: theme.colors.warnSoft, edge: theme.colors.warn, ink: theme.colors.onWarnSoft };
  const alwaysLabel = danger ? null : alwaysSectionLabel(pending);

  return (
    <View
      testID="agent-ask"
      style={{
        padding: theme.space.sm,
        gap: theme.space.xs,
        backgroundColor: band.bg,
        borderRadius: theme.radius.xs,
        borderLeftWidth: theme.layout.ruleEmphasis,
        borderLeftColor: band.edge,
      }}
    >
      <Row justify="space-between" gap="sm">
        <Txt variant="label" color={band.ink}>{approvalHeading(pending.risk)}</Txt>
        {deadline !== undefined ? (
          <Micro testID="agent-ask-countdown" tone={expiryUrgent(deadline, now) ? 'bad' : 'dim'}>
            {`auto-denies in ${countdown(deadline, now)}`}
          </Micro>
        ) : null}
      </Row>

      {/* What is being asked. For Bash the command IS the ask, so it stands
          here in full; the detail line covers everything else. */}
      {render.command !== null ? (
        <ScrollView
          style={{ maxHeight: 120, backgroundColor: theme.colors.surface, borderRadius: theme.radius.xs }}
          contentContainerStyle={{ padding: theme.space.sm }}
          nestedScrollEnabled
        >
          <Txt variant="mono" selectable>
            <Txt variant="mono" tone="accent">{pending.tool}</Txt>
            {'  '}
            {render.command}
          </Txt>
        </ScrollView>
      ) : (
        <Txt variant="mono" selectable numberOfLines={2}>
          <Txt variant="mono" tone="accent">{pending.tool}</Txt>
          {path ? `  ${path}` : pending.detail ? `  ${pending.detail}` : ''}
        </Txt>
      )}

      {render.replaceWarning ? (
        <Txt testID="agent-ask-replaces" variant="caption" color={theme.colors.bad}>
          {render.replaceWarning}
        </Txt>
      ) : null}
      {pending.preview?.kind === 'edit' && pending.preview.replaceAll ? (
        <Micro tone="dim">applies to every occurrence in the file</Micro>
      ) : null}

      {render.diff ? (
        <ScrollView style={{ maxHeight: PREVIEW_MAX_HEIGHT }} nestedScrollEnabled testID="agent-ask-diff">
          <DiffBody diff={render.diff.text} truncated={render.cappedNote !== null} bleed={0} />
        </ScrollView>
      ) : null}

      {/* The raw input survives as a fallback and a second opinion — behind a
          tracked toggle, never as the primary rendering. */}
      {showInput ? (
        <ScrollView
          style={{ maxHeight: 140, backgroundColor: theme.colors.surface, borderRadius: theme.radius.xs }}
          contentContainerStyle={{ padding: theme.space.sm }}
          nestedScrollEnabled
        >
          <Txt variant="monoSmall" tone="dim" selectable>{pending.input}</Txt>
        </ScrollView>
      ) : (
        <TrackLabel
          testID="agent-ask-expand"
          label={render.rawOnly ? 'Show full input ▾' : 'Show raw input ▾'}
          accessibilityLabel="Show the full tool input"
          onPress={() => setShowInput(true)}
          hitSlop={theme.layout.hitSlop}
          style={{ alignSelf: 'flex-start' }}
        />
      )}

      <Row gap="xs">
        <Button testID="agent-deny" label="Deny" variant="danger" size="sm" onPress={() => onAnswer(false)} style={{ flex: 1 }} />
        {danger ? (
          <HoldAllowButton testID="agent-allow" onAllow={() => onAnswer(true)} />
        ) : (
          <Button testID="agent-allow" label="Allow" size="sm" onPress={() => onAnswer(true)} style={{ flex: 1 }} />
        )}
      </Row>

      {/* The stack: asks waiting behind this card, answered in order. A rule
          above the line makes it read as the edge of the next card peeking
          out, not as commentary on this one. */}
      {stackLine ? (
        <View
          testID="agent-ask-stack"
          style={{
            marginTop: theme.space.xs,
            paddingTop: theme.space.xs,
            borderTopWidth: theme.layout.hairline,
            borderTopColor: band.edge,
          }}
        >
          <Micro tone="dim">{stackLine}</Micro>
        </View>
      ) : null}

      {/* Scoped standing permission: the host offered these exact scopes and
          will mint nothing wider. testID kept from the old whole-tool button. */}
      {alwaysLabel ? (
        showChoices ? (
          <View style={{ gap: theme.space.xs }}>
            {(pending.choices ?? []).map((c) => (
              <Button
                key={c.id}
                testID={`agent-always-${c.id}`}
                label={c.label}
                variant="secondary"
                size="sm"
                accessibilityHint="Allows this and everything the label describes, for the rest of this session"
                onPress={() => onAnswer(true, c.id)}
              />
            ))}
            <TrackLabel
              label="Hide options ▴"
              onPress={() => setShowChoices(false)}
              hitSlop={theme.layout.hitSlop}
              style={{ alignSelf: 'flex-start' }}
            />
          </View>
        ) : (
          <TrackLabel
            testID="agent-always"
            label={`${alwaysLabel} ▾`}
            accessibilityLabel="Show always-allow options"
            accessibilityHint="Shows scoped options for allowing this without asking again"
            onPress={() => setShowChoices(true)}
            hitSlop={theme.layout.hitSlop}
            style={{ alignSelf: 'flex-start' }}
          />
        )
      ) : null}
    </View>
  );
}
