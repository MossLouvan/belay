// The terminal's key accessory bar, and the key encoding behind it.
//
// A phone keyboard has no Esc, Tab, Ctrl, arrows, pipe or tilde, and a terminal
// without those is close to unusable. This module lives under `src/` rather than
// next to the screen because expo-router turns every file under `app/` into a
// route — a helper there would render as an extra tab.

import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from './theme';
import { haptic } from './ui';
import { LAUNCH_KEYS, LETTER_KEYS, PRIMARY_KEYS, SYMBOL_KEYS, encodeKey } from './terminal-keymap';
import type { KeyDef } from './terminal-keymap';

// --- key caps ----------------------------------------------------------------

interface KeyCapProps {
  id: string;
  label: string;
  onPress: () => void;
  active?: boolean;
  wide?: boolean;
}

function KeyCap({ id, label, onPress, active, wide }: KeyCapProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={`qkey-${id}`}
      accessibilityRole="button"
      accessibilityLabel={id}
      accessibilityState={{ selected: Boolean(active) }}
      onPress={() => {
        haptic('light');
        onPress();
      }}
      style={({ pressed }) => ({
        minWidth: wide ? 56 : theme.layout.minTouch,
        minHeight: theme.layout.minTouch - 6,
        paddingHorizontal: theme.space.sm,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.sm,
        borderWidth: theme.layout.hairline,
        borderColor: active ? theme.colors.accent : theme.colors.borderStrong,
        backgroundColor: active ? theme.colors.accentSoft : theme.colors.surfaceAlt,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        allowFontScaling={false}
        style={{
          color: active ? theme.colors.onAccentSoft : theme.colors.text,
          fontFamily: theme.font.mono,
          fontSize: 14,
          fontWeight: '700',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export interface KeyBarProps {
  onSend: (data: string) => void;
  onClear: () => void;
  /** Arrows drive local history when the host has no TTY to interpret them. */
  onHistory: (direction: -1 | 1) => void;
  ptyMode: boolean;
}

/**
 * Two rows. The top row is fixed (escape, tab, arrows, the two control codes
 * you actually need) and the bottom row flips between symbols and letters:
 * arming Ctrl or Alt swaps it to letters, which is the only way to type Ctrl+R
 * or Alt+F on a phone. A modifier applies to the next key press — any key, top
 * row included — and is then disarmed, so it can never leak into a later one.
 */
export function KeyBar({ onSend, onClear, onHistory, ptyMode }: KeyBarProps) {
  const theme = useTheme();
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const armed = ctrl || alt;

  const consume = useCallback(() => {
    setCtrl(false);
    setAlt(false);
  }, []);

  const sendChar = useCallback(
    (ch: string) => {
      consume();
      onSend(encodeKey(ch, { ctrl, alt }));
    },
    [alt, consume, ctrl, onSend]
  );

  const pressPrimary = useCallback(
    (key: KeyDef) => {
      consume();
      const isArrow = key.id === 'Up' || key.id === 'Down';
      if (isArrow && !ptyMode) {
        onHistory(key.id === 'Up' ? -1 : 1);
        return;
      }
      if (key.send) onSend(encodeKey(key.send, { ctrl, alt }));
    },
    [alt, consume, ctrl, onHistory, onSend, ptyMode]
  );

  const rowStyle = { gap: 6, paddingHorizontal: theme.space.sm, paddingVertical: 4 } as const;
  const secondary = armed ? LETTER_KEYS : SYMBOL_KEYS;

  return (
    <View style={{ gap: 2 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={rowStyle}>
        <KeyCap id="Ctrl" label="ctrl" active={ctrl} wide onPress={() => setCtrl((v) => !v)} />
        <KeyCap id="Alt" label="alt" active={alt} wide onPress={() => setAlt((v) => !v)} />
        {PRIMARY_KEYS.map((key) => (
          <KeyCap key={key.id} id={key.id} label={key.label} onPress={() => pressPrimary(key)} />
        ))}
        <KeyCap
          id="clear"
          label="clear"
          wide
          onPress={() => {
            consume();
            onClear();
          }}
        />
        {/* Whole command lines: a modifier makes no sense here, so it is
            consumed without being applied. */}
        {LAUNCH_KEYS.map((key) => (
          <KeyCap
            key={key.id}
            id={key.id}
            label={key.label}
            wide={key.wide}
            onPress={() => {
              consume();
              if (key.send) onSend(key.send);
            }}
          />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={rowStyle}>
        {secondary.map((ch) => (
          <KeyCap key={ch} id={ch} label={ch} onPress={() => sendChar(ch)} />
        ))}
      </ScrollView>
    </View>
  );
}
