// The type-to-PC row (the field, its × and Send) and the floating bar that
// carries it on iOS, riding the keyboard's top edge. Absolute so opening it
// moves NOTHING else: the stage keeps its size (the keyboard simply covers
// its lower part) and the dock stays where the thumb left it, ready the
// moment the field is closed. Presentational: the draft, the send and the
// lift come from use-type-row.ts.

import React from 'react';
import { Animated } from 'react-native';
import type { ReactNode } from 'react';
import { useTheme } from '../theme';
import { Button, IconButton, Input, Row, Txt } from '../ui';
import { HUD } from './parts';

export interface TypeRowProps {
  readonly text: string;
  readonly onChangeText: (text: string) => void;
  readonly onSend: () => void;
  readonly onClose: () => void;
}

export function TypeRow({ text, onChangeText, onSend, onClose }: TypeRowProps) {
  return (
    <Row gap="sm">
      <Input
        testID="type-input"
        style={{ flex: 1 }}
        value={text}
        onChangeText={onChangeText}
        placeholder="Type text to send to the PC…"
        accessibilityLabel="Text to type on the host"
        returnKeyType="send"
        onSubmitEditing={onSend}
        submitBehavior="submit"
        autoFocus
        trailing={
          <IconButton
            testID="type-close"
            accessibilityLabel="Stop typing and hide the keyboard"
            variant="plain"
            onPress={onClose}
          >
            <Txt variant="label" tone="dim">×</Txt>
          </IconButton>
        }
      />
      <Button testID="send-text" label="Send" onPress={onSend} size="sm" />
    </Row>
  );
}

export interface FloatingTypeBarProps {
  /** Negative keyboard intrusion: the bar's translateY. */
  readonly lift: Animated.AnimatedMultiplication<number>;
  /** Over live video the bar uses the HUD scrim, matching the floating dock. */
  readonly immersive: boolean;
  readonly children: ReactNode;
}

export function FloatingTypeBar({ lift, immersive, children }: FloatingTypeBarProps) {
  const theme = useTheme();
  return (
    <Animated.View
      testID="type-bar"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10,
        transform: [{ translateY: lift }],
        // Opaque page ground normally; the HUD scrim over live video
        // while immersive, matching the floating dock's chrome.
        backgroundColor: immersive ? HUD.scrim : theme.colors.bg,
        borderTopWidth: theme.layout.hairline,
        borderTopColor: immersive ? HUD.hairline : theme.colors.border,
        paddingHorizontal: theme.layout.margin,
        paddingVertical: theme.space.xs,
      }}
    >
      {children}
    </Animated.View>
  );
}
