// Terminal geometry: how many columns and rows actually fit on screen.
//
// Geometry is measured, never estimated. The row width comes from a zero-height
// header laid out in the same container as the rows (so padding and the web
// scrollbar are already subtracted) and the glyph advance from an invisible
// probe in the real font — guessing either one leaves `cols` a few columns
// wide, which clips the right-hand edge of every wrapped line. A wrong size
// makes anything that draws a full screen render garbage on the host side too.

import { useCallback, useEffect, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

/** Fallback glyph advance, as a fraction of the font size, until the probe measures. */
const CHAR_ADVANCE = 0.6;
/** Characters in the hidden width probe. More characters, less rounding error. */
export const PROBE_CHARS = 40;
export const PROBE_TEXT = 'M'.repeat(PROBE_CHARS);
/** Smallest geometry worth reporting; matches the parser's own floor. */
const MIN_COLS = 20;
const MIN_ROWS = 4;

export interface Geometry {
  readonly cols: number;
  readonly rows: number;
}

/** Raw measurements the geometry is derived from. */
interface Metrics {
  /** Width available to one rendered row, padding and scrollbar excluded. */
  readonly rowWidth: number;
  /** Height of the transcript box, padding included. */
  readonly boxHeight: number;
  /** Measured advance of one monospace glyph, in px. */
  readonly advance: number;
}

export const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 };
const DEFAULT_METRICS: Metrics = { rowWidth: 0, boxHeight: 0, advance: 0 };

export interface TerminalGeometry {
  readonly geometry: Geometry;
  /** Attach to the zero-height list header. */
  readonly onRowWidth: (event: LayoutChangeEvent) => void;
  /** Attach to the hidden glyph probe. */
  readonly onProbeWidth: (event: LayoutChangeEvent) => void;
  /** Attach to the transcript container. */
  readonly onOutputLayout: (event: LayoutChangeEvent) => void;
}

export function useTerminalGeometry(fontSize: number, lineHeight: number, padding: number): TerminalGeometry {
  const [metrics, setMetrics] = useState<Metrics>(DEFAULT_METRICS);
  const [geometry, setGeometry] = useState<Geometry>(DEFAULT_GEOMETRY);

  const onRowWidth = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setMetrics((prev) => (Math.abs(prev.rowWidth - width) < 1 ? prev : { ...prev, rowWidth: width }));
  }, []);

  const onProbeWidth = useCallback((event: LayoutChangeEvent) => {
    const advance = event.nativeEvent.layout.width / PROBE_CHARS;
    if (!Number.isFinite(advance) || advance <= 0) return;
    setMetrics((prev) => (Math.abs(prev.advance - advance) < 0.01 ? prev : { ...prev, advance }));
  }, []);

  const onOutputLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setMetrics((prev) => (Math.abs(prev.boxHeight - height) < 1 ? prev : { ...prev, boxHeight: height }));
  }, []);

  useEffect(() => {
    const advance = metrics.advance > 0 ? metrics.advance : fontSize * CHAR_ADVANCE;
    const width = metrics.rowWidth > 0 ? metrics.rowWidth : 0;
    const height = metrics.boxHeight - padding * 2;
    if (width <= 0 || height <= 0) return;
    // One pixel of slack: sub-pixel rounding in the measured advance can make a
    // row that is arithmetically exact overflow by a fraction, and react-native-web
    // answers an overflowing single-line Text with an ellipsis that eats a column.
    const cols = Math.max(MIN_COLS, Math.floor((width - 1) / advance));
    const rows = Math.max(MIN_ROWS, Math.floor(height / lineHeight));
    setGeometry((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
  }, [fontSize, lineHeight, metrics, padding]);

  return { geometry, onRowWidth, onProbeWidth, onOutputLayout };
}
