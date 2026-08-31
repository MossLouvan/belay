// The ambiguous-completion row: when the shell answers a tab with a list, the
// candidates become keys to tap. On a phone that beats the desktop ritual of
// reading a printed list and typing more letters — the list IS the input
// surface here. Rendered with the key bar's own KeyCap so the row reads as
// more keyboard, not as a new widget to learn.

import React from 'react';
import { ScrollView } from 'react-native';
import { useTheme } from '../theme';
import { Micro } from '../ui';
import { KeyCap } from '../terminal-keys';

/** Beyond this the row is a blur to scroll, not a menu to choose from. */
const MAX_SHOWN = 24;

export interface CandidateRowProps {
  candidates: readonly string[];
  onPick: (candidate: string) => void;
  onDismiss: () => void;
}

export function CandidateRow({ candidates, onPick, onDismiss }: CandidateRowProps) {
  const theme = useTheme();
  const shown = candidates.slice(0, MAX_SHOWN);
  const hidden = candidates.length - shown.length;

  return (
    <ScrollView
      testID="term-candidates"
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      contentContainerStyle={{
        gap: theme.space.xs,
        paddingHorizontal: theme.layout.margin,
        paddingVertical: theme.space.xxs,
        alignItems: 'center',
      }}
    >
      {/* × leads rather than trails: on an overflowing horizontal row the tail
          scrolls out of sight, and a dismiss that must be scrolled to fails
          §11.2's visible-exit rule. */}
      <KeyCap id="cand-close" label="×" onPress={onDismiss} />
      {shown.map((candidate, index) => (
        <KeyCap
          key={`${index}-${candidate}`}
          id={`cand-${index}`}
          label={candidate}
          wide
          onPress={() => onPick(candidate)}
        />
      ))}
      {hidden > 0 ? <Micro>{`+${hidden} MORE — KEEP TYPING`}</Micro> : null}
    </ScrollView>
  );
}
