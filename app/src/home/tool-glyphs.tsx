// The four tool glyphs, moved here from the retired bottom tab bar so the
// tool drawer keeps the exact iconography users already learned. Hand-drawn
// from Views on purpose: @expo/vector-icons is not a dependency, and an icon
// font for four glyphs would cost a web fetch for no visual gain. All strokes
// are the ledger's 1.5pt outline — never filled blobs (docs/DESIGN.md §11.1).

import React from 'react';
import { Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { font } from '../theme';
import type { ToolId } from './tools';

/** The one stroke weight every glyph is drawn with — a thin outline. */
const STROKE = 1.5;

const GLYPH_BOX: ViewStyle = { alignItems: 'center', justifyContent: 'center', width: 24, height: 24 };

interface GlyphProps {
  readonly color: string;
}

/** A spark: a rotated square with a point at its centre — "something is working for you". */
function AgentGlyph({ color }: GlyphProps) {
  return (
    <View style={GLYPH_BOX}>
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 2,
          borderWidth: STROKE,
          borderColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
      <View style={{ position: 'absolute', width: 3, height: 3, borderRadius: 1.5, backgroundColor: color }} />
    </View>
  );
}

/** Terminal window with a prompt. */
function TerminalGlyph({ color }: GlyphProps) {
  return (
    <View style={[GLYPH_BOX, { borderRadius: 2, borderWidth: STROKE, borderColor: color }]}>
      <Text allowFontScaling={false} style={{ color, fontFamily: font.mono, fontSize: 10, marginTop: -1 }}>
        {'>_'}
      </Text>
    </View>
  );
}

/** Folder with a tab. */
function FilesGlyph({ color }: GlyphProps) {
  return (
    <View style={GLYPH_BOX}>
      <View
        style={{
          position: 'absolute',
          top: 3.5,
          left: 2,
          width: 9,
          height: 5,
          borderTopWidth: STROKE,
          borderLeftWidth: STROKE,
          borderRightWidth: STROKE,
          borderColor: color,
          borderTopLeftRadius: 2,
          borderTopRightRadius: 2,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: 6,
          width: 20,
          height: 14,
          borderRadius: 2,
          borderWidth: STROKE,
          borderColor: color,
          backgroundColor: 'transparent',
        }}
      />
    </View>
  );
}

/** Three-bar activity chart — outlined, so it matches the stroke language. */
function SystemGlyph({ color }: GlyphProps) {
  const bar = (height: number): ViewStyle => ({
    width: 5,
    height,
    borderWidth: STROKE,
    borderColor: color,
    borderRadius: 1,
  });
  return (
    <View style={[GLYPH_BOX, { flexDirection: 'row', alignItems: 'flex-end', gap: 2.5 }]}>
      <View style={bar(8)} />
      <View style={bar(16)} />
      <View style={bar(11)} />
    </View>
  );
}

const GLYPHS: Record<ToolId, (props: GlyphProps) => React.JSX.Element> = {
  agent: AgentGlyph,
  terminal: TerminalGlyph,
  files: FilesGlyph,
  system: SystemGlyph,
};

/** The drawer row's leading mark for one tool. */
export function ToolGlyph({ id, color }: { id: ToolId; color: string }) {
  const Glyph = GLYPHS[id];
  return (
    // Decorative: the row's own title names the tool, and the terminal
    // glyph's ">_" text would otherwise leak into the accessible name.
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
      <Glyph color={color} />
    </View>
  );
}
