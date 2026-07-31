// One rendered line of the terminal transcript.

import React, { useMemo } from 'react';
import { Text } from 'react-native';
import { lineToSpans, spanColors } from './terminal-ansi';
import type { Span, TermLine } from './terminal-ansi';

export interface TermRowProps {
  line: TermLine;
  ramp: readonly string[];
  fg: string;
  bg: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

/**
 * Unchanged lines keep object identity across a feed, so memoising on `line`
 * means a burst of output only re-renders what actually moved.
 */
export const TermRow = React.memo(function TermRow({
  line,
  ramp,
  fg,
  bg,
  fontFamily,
  fontSize,
  lineHeight,
}: TermRowProps) {
  const spans: readonly Span[] = useMemo(() => lineToSpans(line), [line]);
  const base = { fontFamily, fontSize, lineHeight, height: lineHeight, color: fg };
  if (spans.length === 0) return <Text style={base}> </Text>;
  return (
    <Text selectable numberOfLines={1} ellipsizeMode="clip" style={base}>
      {spans.map((span, i) => (
        <Text key={i} style={spanColors(span.style, ramp, fg, bg)}>
          {span.text}
        </Text>
      ))}
    </Text>
  );
});
