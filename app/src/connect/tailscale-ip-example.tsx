// Annotated example showing where to find the Tailscale IP (100.x.x.x).
//
// An illustration in Belay's own style, teaching users exactly which address
// they need during setup — no more hunting through Tailscale's UI for the
// right number.
//
// It is drawn as an EXAMPLE and says so, out loud, twice: a label above the
// card and a dashed edge instead of the solid hairline every real card in the
// app carries. Without that it used the same surface, border, status dot and
// mono-address vocabulary as a genuine device row, so a first-timer could read
// a made-up machine ("Sample laptop", 100.64.12.34 — a documentation address,
// not anyone's) as their own computer and type the wrong number in.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Caption, Label, Txt } from '../ui';

/** The illustration's fixed card width — it is a picture, not a layout. */
const CARD_WIDTH = 280;
/** The status dot's diameter; sub-4pt because it is glyph geometry. */
const DOT = 6;

export interface TailscaleIpExampleProps {
  style?: object;
}

/**
 * A sample Tailscale device row with its 100.x address called out. The visual
 * example and label make the specific address unmistakable — solving the setup
 * pain point where users didn't know which of Tailscale's many numbers was the
 * one Belay needed.
 */
export function TailscaleIpExample({ style }: TailscaleIpExampleProps) {
  const theme = useTheme();

  return (
    <View style={[{ alignItems: 'center', gap: theme.space.xs }, style]} testID="tailscale-ip-example">
      <Label tone="faint">Example — not your computer</Label>

      <View
        // Dashed, so the eye reads "diagram" before it reads the words. Every
        // real card in the app is a solid hairline.
        style={{
          width: CARD_WIDTH,
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.sm,
          borderWidth: theme.layout.ruleEmphasis,
          borderStyle: 'dashed',
          borderColor: theme.colors.border,
          padding: theme.space.md,
          gap: theme.space.xs,
        }}
      >
        <Txt variant="subheading" tone="dim">Sample laptop</Txt>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xxs }}>
          <View
            style={{
              width: DOT,
              height: DOT,
              borderRadius: DOT / 2,
              backgroundColor: theme.colors.accentGraphic,
            }}
          />
          <Txt variant="caption" tone="dim">Connected</Txt>
        </View>

        {/* The Tailscale IP — THIS is what users need. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginTop: theme.space.xxs }}>
          <View
            style={{
              backgroundColor: theme.colors.accentSoft,
              paddingHorizontal: theme.space.sm,
              paddingVertical: theme.space.xxs,
              borderRadius: theme.radius.xs,
              borderWidth: theme.layout.ruleEmphasis,
              borderColor: theme.colors.accent,
            }}
          >
            {/* `onAccentSoft`, not `accent`: the solid accent is only verified
                against the opaque surfaces, and this sits on a soft fill. Mono
                is never bold here — bold mono is banned (DESIGN.md §12). */}
            <Txt variant="mono" style={{ color: theme.colors.onAccentSoft }}>100.64.12.34</Txt>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xxs }}>
            <Txt variant="label" style={{ color: theme.colors.accent }}>{'→'}</Txt>
            <View
              style={{
                backgroundColor: theme.colors.accent,
                paddingHorizontal: theme.space.xs,
                paddingVertical: theme.space.xxs,
                borderRadius: theme.radius.xs,
              }}
            >
              <Txt variant="micro" style={{ color: theme.colors.onAccent }}>Use this IP</Txt>
            </View>
          </View>
        </View>
      </View>

      <Caption style={{ textAlign: 'center', maxWidth: 260 }}>
        In the Tailscale app, find your own computer and note its{' '}
        <Txt variant="mono" style={{ color: theme.colors.accent }}>100.x.x.x</Txt> address
      </Caption>
    </View>
  );
}
