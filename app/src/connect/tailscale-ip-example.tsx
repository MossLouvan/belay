// Annotated example showing where to find the Tailscale IP (100.x.x.x).
//
// A polished illustration matching Belay's dark/Ledger style, teaching users
// exactly which address they need during setup. The arrow and callout make it
// impossible to miss — no more hunting through Tailscale's UI for the right
// number.

import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Caption, Txt } from '../ui';

export interface TailscaleIpExampleProps {
  style?: object;
}

/**
 * A mock Tailscale device list showing one device with its 100.x IP clearly
 * highlighted. The visual example and label make the specific address
 * unmistakable — solving the setup pain point where users didn't know which
 * of Tailscale's many numbers was the one Belay needed.
 */
export function TailscaleIpExample({ style }: TailscaleIpExampleProps) {
  const theme = useTheme();

  return (
    <View style={[{ alignItems: 'center', gap: theme.space.md }, style]} testID="tailscale-ip-example">
      {/* Mock Tailscale device card */}
      <View
        style={{
          width: 280,
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.sm,
          borderWidth: theme.layout.hairline,
          borderColor: theme.colors.border,
          padding: theme.space.md,
          gap: theme.space.xs,
        }}
      >
        {/* Device name */}
        <Txt variant="subheading">My MacBook Pro</Txt>

        {/* Connection status */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.xxs }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: theme.colors.accentGraphic,
            }}
          />
          <Txt variant="caption" tone="dim">
            Connected
          </Txt>
        </View>

        {/* The Tailscale IP - THIS is what users need */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginTop: theme.space.xxs }}>
          <View
            style={{
              backgroundColor: theme.colors.accentSoft,
              paddingHorizontal: theme.space.sm,
              paddingVertical: theme.space.xxs,
              borderRadius: theme.radius.xs,
              borderWidth: 1.5,
              borderColor: theme.colors.accent,
            }}
          >
            <Txt variant="mono" style={{ color: theme.colors.accent, fontWeight: '700' }}>
              100.64.12.34
            </Txt>
          </View>

          {/* Arrow and label */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space.xxs,
            }}
          >
            <Txt variant="label" style={{ color: theme.colors.accent }}>
              {'→'}
            </Txt>
            <View
              style={{
                backgroundColor: theme.colors.accent,
                paddingHorizontal: theme.space.xs,
                paddingVertical: 2,
                borderRadius: theme.radius.xs,
              }}
            >
              <Txt variant="label" style={{ color: theme.colors.onAccent, fontSize: 11 }}>
                Use this IP
              </Txt>
            </View>
          </View>
        </View>
      </View>

      {/* Caption explaining what they're looking at */}
      <Caption style={{ textAlign: 'center', maxWidth: 260 }}>
        In the Tailscale app, find your computer and note its <Txt variant="mono" style={{ color: theme.colors.accent }}>100.x.x.x</Txt> address
      </Caption>
    </View>
  );
}
