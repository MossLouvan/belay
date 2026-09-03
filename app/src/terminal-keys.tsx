// The terminal's key accessory bar, and the key encoding behind it.
//
// A phone keyboard has no Esc, Tab, Ctrl, arrows, pipe or tilde, and a terminal
// without those is close to unusable. This module lives under `src/` rather than
// next to the screen because expo-router turns every file under `app/` into a
// route — a helper there would render as an extra tab.

import React, { useCallback, useRef, useState } from 'react';
import { Animated, Keyboard, Pressable, ScrollView, Text, View } from 'react-native';
import { easing, useTheme } from './theme';
import { haptic, useReducedMotion } from './ui';
import { LAUNCH_KEYS, LETTER_KEYS, PRIMARY_KEYS, SYMBOL_KEYS, encodeKey } from './terminal-keymap';
import type { KeyDef } from './terminal-keymap';

// --- key caps ----------------------------------------------------------------

export interface KeyCapProps {
  id: string;
  label: string;
  onPress: () => void;
  active?: boolean;
  wide?: boolean;
  /** Spoken name when the cap's `id` is not self-describing (e.g. `Aa`). */
  accessibilityLabel?: string;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function KeyCap({ id, label, onPress, active, wide, accessibilityLabel }: KeyCapProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);

  // Ignition drive, the same rope idiom as TrackLabel (REVAMP-SPEC §3.5):
  // 0 = slack, 1 = loaded. Press-in SNAPS the chip from its granite-quiet
  // `surfaceAlt` rest to the blue `accentSoft` load — no ramp; release
  // relaxes back over `motion.fast`. No opacity dim, no scale — the key
  // feels mechanical, and holds still otherwise.
  const load = useRef(new Animated.Value(0)).current;

  const handlePressIn = useCallback(() => {
    setPressed(true);
    load.stopAnimation();
    load.setValue(1);
  }, [load]);

  const handlePressOut = useCallback(() => {
    setPressed(false);
    Animated.timing(load, {
      toValue: 0,
      duration: reducedMotion ? theme.motion.fast / 2 : theme.motion.fast,
      easing: easing.standard,
      // Colour interpolation cannot ride the native driver.
      useNativeDriver: false,
    }).start();
  }, [load, reducedMotion, theme.motion.fast]);

  // An armed modifier holds its lit state steady; every other chip ignites
  // only under the finger.
  const background: string | Animated.AnimatedInterpolation<string> = active
    ? theme.colors.accentSoft
    : load.interpolate({
        inputRange: [0, 1],
        outputRange: [theme.colors.surfaceAlt, theme.colors.accentSoft],
      });

  return (
    <AnimatedPressable
      testID={`qkey-${id}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? id}
      accessibilityState={{ selected: Boolean(active) }}
      onPress={() => {
        haptic('light');
        onPress();
      }}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      // A recessed surfaceAlt chip with 4pt corners — the one sanctioned
      // radius above the 2pt standard — and no border box; only the armed
      // state draws its accent hairline. Bold mono is banned (DESIGN.md §12).
      style={{
        minWidth: wide ? 56 : theme.layout.minTouch,
        minHeight: theme.layout.minTouch,
        paddingHorizontal: theme.space.sm,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.sm,
        borderWidth: active ? theme.layout.hairline : 0,
        borderColor: theme.colors.accent,
        backgroundColor: background,
      }}
    >
      <Text
        allowFontScaling={false}
        style={{
          color: active || pressed ? theme.colors.onAccentSoft : theme.colors.text,
          fontFamily: theme.font.mono,
          fontSize: 13,
        }}
      >
        {label}
      </Text>
    </AnimatedPressable>
  );
}

export interface KeyBarProps {
  onSend: (data: string) => void;
  onClear: () => void;
  /** Arrows drive local history when the host has no TTY to interpret them. */
  onHistory: (direction: -1 | 1) => void;
  /**
   * An unmodified Tab is the screen's, not the shell's: with text in the input
   * it runs the completion dance, with none it falls back to a raw `\t`. A
   * modified Tab (Ctrl/Alt armed) still takes the plain encoding path.
   */
  onTab: () => void;
  ptyMode: boolean;
  /**
   * The text-size cycle (`Aa`), a bar concern rather than a header one: it
   * changes how the transcript reads, and it lives with the other keys.
   * Each press steps sm → md → lg → sm; `fontLabel` names the current step
   * for the screen reader.
   */
  onFontCycle?: () => void;
  fontLabel?: string;
}

/**
 * Two rows. The top row is fixed (escape, tab, arrows, the two control codes
 * you actually need) and the bottom row flips between symbols and letters:
 * arming Ctrl or Alt swaps it to letters, which is the only way to type Ctrl+R
 * or Alt+F on a phone. A modifier applies to the next key press — any key, top
 * row included — and is then disarmed, so it can never leak into a later one.
 */
export function KeyBar({ onSend, onClear, onHistory, onTab, ptyMode, onFontCycle, fontLabel }: KeyBarProps) {
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
      const wasArmed = ctrl || alt;
      consume();
      if (key.id === 'Tab' && !wasArmed) {
        onTab();
        return;
      }
      const isArrow = key.id === 'Up' || key.id === 'Down';
      if (isArrow && !ptyMode) {
        onHistory(key.id === 'Up' ? -1 : 1);
        return;
      }
      if (key.send) onSend(encodeKey(key.send, { ctrl, alt }));
    },
    [alt, consume, ctrl, onHistory, onSend, onTab, ptyMode]
  );

  // Rows lead with the 20pt page gutter so the first key sits on the grid's
  // left edge like everything else on the page.
  const rowStyle = { gap: theme.space.xs, paddingHorizontal: theme.layout.margin, paddingVertical: theme.space.xxs } as const;
  const secondary = armed ? LETTER_KEYS : SYMBOL_KEYS;

  return (
    <View style={{ gap: theme.space.none }}>
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
        {/* Text size lives with the keys, not in the header: it is a bar
            control over how the transcript reads. One cap, cycling
            sm → md → lg — a modifier makes no sense on it, so it is
            consumed without being applied. */}
        {onFontCycle ? (
          <KeyCap
            id="Aa"
            label="Aa"
            accessibilityLabel={fontLabel ? `Text size, ${fontLabel}` : 'Text size'}
            wide
            onPress={() => {
              consume();
              onFontCycle();
            }}
          />
        ) : null}
        {/* The keyboard is a state and needs a visible exit (docs/DESIGN.md
            §11.2). Return can't dismiss here — it runs the command — and the
            transcript's tap-to-blur is invisible, so the bar that sits right
            above the keyboard carries the way out, as terminal apps do. */}
        <KeyCap
          id="hide"
          label="⌄ hide"
          wide
          onPress={() => {
            consume();
            Keyboard.dismiss();
          }}
        />
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={rowStyle}>
        {secondary.map((ch) => (
          <KeyCap key={ch} id={ch} label={ch} onPress={() => sendChar(ch)} />
        ))}
      </ScrollView>
    </View>
  );
}
