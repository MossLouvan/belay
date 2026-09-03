// One line of the session feed: the user's prompt marked by a "YOU" label and
// an emphasis rule, Claude's narration as prose, tool calls as a mono
// one-liner with the machine's answer folded underneath, results as a tally.
// No bubbles — the feed is a transcript column on the page, and hierarchy
// comes from type and the one accent rule.

import React, { useState } from 'react';
import { View } from 'react-native';
import type { AgentEvent } from '../api';
import { useTheme } from '../theme';
import { Micro, Row, TrackLabel, Txt } from '../ui';
import { resultSummary } from './model';
import { resultToggleLabel, resultTruncated, truncationNote } from './feed-model';
import { CopyLabel } from './copy-label';
import { showMessageCopy } from './copy-model';

// What a tool call came back with, collapsed to one tracked toggle by
// default: a wall of raw output would drown the narration, but "what did
// that actually print" must be one tap away, not a laptop away. The toggle
// is a TrackLabel — the track rule (docs/DESIGN.md §11.1) is what makes it
// unmistakably tappable — and a failure carries the bad ink on label and
// track both, so "it ran" and "it ran and errored" never look alike.
function ToolResult({ result }: { result: AgentEvent }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const failed = result.ok === false;

  // Nothing came back — say so inertly. An expand control over an empty
  // panel would be a label that does nothing, which the track rule forbids.
  if (!result.text) {
    return (
      <Micro tone={failed ? 'bad' : 'faint'}>{failed ? '✗ failed — no output' : 'no output'}</Micro>
    );
  }

  return (
    <View style={{ gap: theme.space.xxs }}>
      <TrackLabel
        label={resultToggleLabel(result, expanded)}
        onPress={() => setExpanded((v) => !v)}
        active={expanded}
        labelColor={failed ? theme.colors.bad : undefined}
        trackColor={failed ? theme.colors.bad : undefined}
        accessibilityLabel={failed ? 'Failed tool output' : 'Tool output'}
        accessibilityHint={expanded ? 'Collapses the output' : 'Expands the output'}
        style={{ alignSelf: 'flex-start' }}
      />
      {expanded ? (
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radius.xs,
            borderLeftWidth: theme.layout.ruleEmphasis,
            borderLeftColor: failed ? theme.colors.bad : theme.colors.border,
            padding: theme.space.sm,
            gap: theme.space.xxs,
          }}
        >
          <Txt variant="monoSmall" tone="dim" selectable>{result.text}</Txt>
          <Row justify="space-between" gap="sm">
            {/* Selection handles across a wall of mono output are a fight;
                the block's own Copy lifts the whole thing in one tap. */}
            <CopyLabel
              testID="feed-copy-output"
              text={result.text}
              accessibilityLabel="Copy this tool output"
            />
            {resultTruncated(result) ? <Micro>{truncationNote(result)}</Micro> : null}
          </Row>
        </View>
      ) : null}
    </View>
  );
}

export function EventRow({ event, result }: { event: AgentEvent; result?: AgentEvent }) {
  const theme = useTheme();

  if (event.kind === 'user') {
    return (
      <View
        style={{
          borderLeftWidth: theme.layout.ruleEmphasis,
          borderLeftColor: theme.colors.accentGraphic,
          paddingLeft: theme.space.sm,
          gap: theme.space.xxs,
        }}
      >
        <Row justify="space-between" gap="sm">
          <Micro tone="dim">You</Micro>
          {/* A prompt is the message most often re-sent elsewhere, so the
              whole block is one tap away, not a selection-handle fight. */}
          {showMessageCopy(event) ? (
            <CopyLabel testID="feed-copy-prompt" text={event.text ?? ''} accessibilityLabel="Copy this prompt" />
          ) : null}
        </Row>
        <Txt selectable>{event.text}</Txt>
      </View>
    );
  }
  if (event.kind === 'text') {
    // Short lines lean on selection alone; long or multi-line prose earns a
    // quiet Copy for the "give me the whole answer" gesture.
    if (!showMessageCopy(event)) {
      return (
        <Txt selectable style={{ maxWidth: '95%' }}>
          {event.text}
        </Txt>
      );
    }
    return (
      <View style={{ gap: theme.space.xxs }}>
        <Txt selectable style={{ maxWidth: '95%' }}>
          {event.text}
        </Txt>
        <CopyLabel
          testID="feed-copy-message"
          text={event.text ?? ''}
          accessibilityLabel="Copy this message"
          style={{ alignSelf: 'flex-start' }}
        />
      </View>
    );
  }
  if (event.kind === 'tool') {
    return (
      <View style={{ gap: theme.space.xxs }}>
        <Txt variant="monoSmall" tone="dim" numberOfLines={2} selectable>
          <Txt variant="monoSmall" tone="accent">{`▸ ${event.tool ?? 'tool'}`}</Txt>
          {event.detail ? `  ${event.detail}` : ''}
        </Txt>
        {result ? (
          <View style={{ paddingLeft: theme.space.sm }}>
            <ToolResult result={result} />
          </View>
        ) : null}
      </View>
    );
  }
  if (event.kind === 'tool-result') {
    // An orphan: its call fell off the event cap, or came from another
    // version. Evidence still renders, just without a line to hang under.
    return <ToolResult result={event} />;
  }
  if (event.kind === 'result') {
    return (
      <View style={{ gap: 2 }}>
        <Txt variant="monoSmall" tone={event.ok ? 'good' : 'bad'} selectable>{resultSummary(event)}</Txt>
        {!event.ok && event.text ? <Txt variant="caption" tone="dim" selectable>{event.text}</Txt> : null}
      </View>
    );
  }
  if (event.kind === 'error') {
    return <Txt variant="caption" tone="bad" selectable>{event.text}</Txt>;
  }
  return (
    <Txt variant="caption" tone="faint" selectable>
      {event.text}
    </Txt>
  );
}
