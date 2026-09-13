// Appearance picker. "Auto" rather than "System" on purpose: a segment labelled
// "System" would collide with the System tab for anything matching on text.

import React, { useCallback } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { SegmentOption, SegmentedControl } from '../ui';
import { ThemeMode, useTheme } from '../theme';
import { persistThemeMode } from './theme-mode';

const OPTIONS: readonly SegmentOption<ThemeMode>[] = [
  { value: 'current', label: 'Current' },
  { value: 'fieldwork', label: 'Fieldwork' },
];

export interface ThemeToggleProps {
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The two-appearance control, wired to the persisted theme mode.
 *
 * `value` is derived from the RESOLVED theme rather than the stored mode, so
 * the selected segment always matches what the user is looking at — including
 * when the stored mode is 'system' and the OS is the one choosing.
 */
export function ThemeToggle({ style, testID }: ThemeToggleProps) {
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
