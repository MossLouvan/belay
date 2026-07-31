// Appearance picker. "Auto" rather than "System" on purpose: a segment labelled
// "System" would collide with the System tab for anything matching on text.

import React, { useCallback } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { SegmentOption, SegmentedControl } from '../ui';
import { ThemeMode, useThemeMode } from '../theme';
import { persistThemeMode } from './theme-mode';

const OPTIONS: readonly SegmentOption<ThemeMode>[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export interface ThemeToggleProps {
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Three-way appearance control, wired to the persisted theme mode. */
export function ThemeToggle({ style, testID }: ThemeToggleProps) {
  const mode = useThemeMode();

  const onChange = useCallback((next: ThemeMode) => {
    // Fire-and-forget: the mode applies synchronously, only the write is async.
    void persistThemeMode(next);
  }, []);

  return (
    <SegmentedControl
      options={OPTIONS}
      value={mode}
      onChange={onChange}
      accessibilityLabel="Appearance"
      testID={testID}
      style={style}
    />
  );
}
