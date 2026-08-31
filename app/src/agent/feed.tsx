// One line of the session feed: the user's prompt marked by a "YOU" label and
// an emphasis rule, Claude's narration as prose, tool calls as a mono
// one-liner, results as a tally. No bubbles — the feed is a transcript column
// on the page, and hierarchy comes from type and the one accent rule.

import React from 'react';
import { View } from 'react-native';
import type { AgentEvent } from '../api';
import { useTheme } from '../theme';
import { Micro, Txt } from '../ui';
import { resultSummary } from './model';

export function EventRow({ event }: { event: AgentEvent }) {
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
        <Micro tone="dim">You</Micro>
        <Txt selectable>{event.text}</Txt>
      </View>
    );
  }
  if (event.kind === 'text') {
    return (
      <Txt selectable style={{ maxWidth: '95%' }}>
        {event.text}
      </Txt>
    );
  }
  if (event.kind === 'tool') {
    return (
      <Txt variant="monoSmall" tone="dim" numberOfLines={2}>
        <Txt variant="monoSmall" tone="accent">{`▸ ${event.tool ?? 'tool'}`}</Txt>
        {event.detail ? `  ${event.detail}` : ''}
      </Txt>
    );
  }
  if (event.kind === 'result') {
    return (
      <View style={{ gap: 2 }}>
        <Txt variant="monoSmall" tone={event.ok ? 'good' : 'bad'}>{resultSummary(event)}</Txt>
        {!event.ok && event.text ? <Txt variant="caption" tone="dim">{event.text}</Txt> : null}
      </View>
    );
  }
  if (event.kind === 'error') {
    return <Txt variant="caption" tone="bad">{event.text}</Txt>;
  }
  return (
    <Txt variant="caption" tone="faint">
      {event.text}
    </Txt>
  );
}
