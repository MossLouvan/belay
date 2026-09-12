// Appearance picker. "Auto" rather than "System" on purpose: a segment labelled
// "System" would collide with the System tab for anything matching on text.

import React, { useCallback } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { SegmentOption, SegmentedControl } from '../ui';
import { ThemeMode, useThemeMode, useTheme } from '../theme';
import { persistThemeMode } from './theme-mode';

const OPTIONS: readonly SegmentOption<ThemeMode>[] = [
  { value: 'current', label: 'Current' },
  { value: 'fieldwork', label: 'Fieldwork' },
];

export interface ThemeToggleProps {
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Three-way appearance control, wired to the persisted theme mode. */
export function ThemeToggle({ style, testID }: ThemeToggleProps) {
  const mode = useThemeMode();
  const theme = useTheme();

  const onChange = useCallback((next: ThemeMode) => {
    // Fire-and-forget: the mode applies synchronously, only the write is async.
    void persistThemeMode(next);
  }, []);

  return (
    <SegmentedControl
      options={OPTIONS}
      value={theme.isDark ? 'fieldwork' : 'current'}
      onChange={onChange}
      accessibilityLabel="Appearance"
      role="radio"
      testID={testID}
      style={style}
    />
  );
}
