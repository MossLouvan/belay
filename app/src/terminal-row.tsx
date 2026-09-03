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
  /**
   * When set, this row holds the shell's cursor: the cell at this column is
   * painted as a steady block — `cursorColor` behind ink of the panel ground.
   * Never a blink (docs/DESIGN.md: motion must mean something).
   */
  cursorCol?: number;
  cursorColor?: string;
}

/** A slice of a line, for painting the cursor cell separately. */
function sliceLine(line: TermLine, start: number, end?: number): TermLine {
  return { chars: line.chars.slice(start, end), styles: line.styles.slice(start, end) };
}

function renderSpans(spans: readonly Span[], ramp: readonly string[], fg: string, bg: string, keyBase: string) {
  return spans.map((span, i) => (
    <Text key={`${keyBase}${i}`} style={spanColors(span.style, ramp, fg, bg)}>
      {span.text}
    </Text>
  ));
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
  cursorCol,
  cursorColor,
}: TermRowProps) {
  const hasCursor = cursorCol !== undefined && cursorColor !== undefined;
  // The cursor splits the line into before / cell / after so only the one
  // cell inverts; without a cursor the whole line renders in one pass.
  const parts = useMemo(() => {
    if (!hasCursor) return { spans: lineToSpans(line), before: null, at: null, after: null };
    const col = cursorCol as number;
    return {
      spans: null,
      before: lineToSpans(sliceLine(line, 0, col)),
      at: line.chars[col] ?? ' ',
      after: lineToSpans(sliceLine(line, col + 1)),
    };
  }, [hasCursor, cursorCol, line]);

  const base = { fontFamily, fontSize, lineHeight, height: lineHeight, color: fg };
  if (parts.spans !== null) {
    if (parts.spans.length === 0) return <Text style={base}> </Text>;
    return (
      <Text selectable numberOfLines={1} ellipsizeMode="clip" style={base}>
        {renderSpans(parts.spans, ramp, fg, bg, '')}
      </Text>
    );
  }
  return (
    <Text selectable numberOfLines={1} ellipsizeMode="clip" style={base}>
      {renderSpans(parts.before ?? [], ramp, fg, bg, 'b')}
      <Text style={{ backgroundColor: cursorColor, color: bg }}>{parts.at}</Text>
      {renderSpans(parts.after ?? [], ramp, fg, bg, 'a')}
    </Text>
  );
});
