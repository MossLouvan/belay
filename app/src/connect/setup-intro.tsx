// Apple-style minimal setup intro screens — inspired by lunarOS mockups.
//
// Pure black canvas, typography-first, huge negative space. Welcome + how it
// works before the connect flow. Fade transitions between stages.

import React from 'react';
import { View, Pressable } from 'react-native';
import { useTheme } from '../theme';
import { Button, Txt } from '../ui';

interface WelcomeScreenProps {
  onContinue: () => void;
}

/**
 * Welcome screen — pure minimal aesthetic, lowercase friendly, huge type,
 * enormous negative space. First impression: calm, confident, premium.
 */
export function WelcomeScreen({ onContinue }: WelcomeScreenProps) {
  const theme = useTheme();

  return (
    <View
      testID="welcome-screen"
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: theme.layout.margin * 2,
        gap: theme.space.xxl * 2,
      }}
    >
      {/* Hero headline — huge, centered, minimal */}
      <View style={{ alignItems: 'center', gap: theme.space.md }}>
        <Txt
          variant="display"
          style={{
            fontSize: 48,
            lineHeight: 52,
            textAlign: 'center',
            color: theme.colors.text,
            textTransform: 'none',
          }}
        >
          welcome to
        </Txt>
        <Txt
          variant="display"
          style={{
            fontSize: 56,
            lineHeight: 60,
            textAlign: 'center',
            color: theme.colors.accentGraphic,
            letterSpacing: -2,
          }}
        >
          BELAY
        </Txt>
      </View>

      {/* Minimal tagline */}
      <Txt
        variant="body"
        tone="dim"
        style={{
          textAlign: 'center',
          maxWidth: 280,
          fontSize: 16,
          lineHeight: 24,
        }}
      >
        Control your computer from your phone. No cloud, no middleman.
      </Txt>

      {/* Simple continue CTA */}
      <View style={{ width: '100%', maxWidth: 280, marginTop: theme.space.xl }}>
        <Button
          label="Get started"
          onPress={onContinue}
          fullWidth
          size="lg"
          testID="welcome-continue"
        />
      </View>
    </View>
  );
}

interface HowItWorksScreenProps {
  onContinue: () => void;
  onBack?: () => void;
}

/**
 * How it works — single screen explaining the concept, typography-first,
 * minimal list. Not a dense card wall, just clean vertical prose.
 */
export function HowItWorksScreen({ onContinue, onBack }: HowItWorksScreenProps) {
  const theme = useTheme();

  const steps = [
    {
      label: '01',
      title: 'Start the host on your computer',
      detail: 'A small program that lets Belay connect. Leave it running.',
    },
    {
      // Away-from-home is the main use case, so Tailscale is a headline step
      // of the setup, not fine print — the guided walk-through comes next.
      label: '02',
      title: 'Set up Tailscale',
      detail: 'A free app that lets your phone reach your computer from anywhere. Belay walks you through it next.',
    },
    {
      label: '03',
      title: 'Pair your phone once',
      detail: 'Scan the QR code on your computer. After that, your phone remembers it.',
    },
    {
      label: '04',
      title: 'Control your computer',
      detail: 'Screen, terminal, files, system — all from your phone.',
    },
  ];

  return (
    <View
      testID="how-it-works-screen"
      style={{
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: theme.layout.margin * 1.5,
        gap: theme.space.xxl,
      }}
    >
      {/* Section headline */}
      <View style={{ gap: theme.space.sm }}>
        <Txt
          variant="title"
          style={{
            fontSize: 32,
            lineHeight: 36,
            textTransform: 'none',
            color: theme.colors.text,
          }}
        >
          how it works
        </Txt>
        <Txt variant="caption" tone="dim" style={{ fontSize: 15, lineHeight: 22 }}>
          Direct connection between your devices. Nothing routes through anyone else.
        </Txt>
      </View>

      {/* Clean vertical step list */}
      <View style={{ gap: theme.space.lg }}>
        {steps.map((step) => (
          <View
            key={step.label}
            style={{
              flexDirection: 'row',
              gap: theme.space.md,
              alignItems: 'flex-start',
            }}
          >
            {/* Mono ordinal in margin */}
            <Txt
              variant="label"
              tone="accent"
              style={{
                width: 40,
                marginTop: 2,
              }}
            >
              {step.label}
            </Txt>

            {/* Content */}
            <View style={{ flex: 1, gap: theme.space.xxs }}>
              <Txt
                variant="bodyStrong"
                style={{
                  fontSize: 16,
                  lineHeight: 22,
                }}
              >
                {step.title}
              </Txt>
              <Txt
                variant="caption"
                tone="dim"
                style={{
                  fontSize: 14,
                  lineHeight: 20,
                }}
              >
                {step.detail}
              </Txt>
            </View>
          </View>
        ))}
      </View>

      {/* CTAs */}
      <View style={{ gap: theme.space.sm, marginTop: theme.space.lg }}>
        <Button
          label="Continue"
          onPress={onContinue}
          fullWidth
          size="lg"
          testID="how-it-works-continue"
        />
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={8}
            style={({ pressed }) => ({
              paddingVertical: theme.space.sm,
              minHeight: 44,
              justifyContent: 'center',
              opacity: pressed ? theme.motion.pressOpacity : 1,
            })}
          >
            <Txt
              variant="body"
              tone="dim"
              style={{
                textAlign: 'center',
                fontSize: 15,
              }}
            >
              ← Back
            </Txt>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
