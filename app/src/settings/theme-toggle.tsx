// Appearance picker. "Auto" rather than "System" on purpose: a segment labelled
// "System" would collide with the System tab for anything matching on text.

import React, { useCallback } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { SegmentOption, SegmentedControl } from '../ui';
import { ThemeMode, useAppearance } from '../theme';
import { persistThemeMode } from './theme-mode';

const OPTIONS: readonly SegmentOption<ThemeMode>[] = [
  { value: 'harbour', label: 'Harbour' },
  { value: 'harbour-night', label: 'Night' },
  { value: 'current', label: 'Current' },
  { value: 'fieldwork', label: 'Fieldwork' },
];

export interface ThemeToggleProps {
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Four-way appearance control, wired to the persisted theme mode. */
export function ThemeToggle({ style, testID }: ThemeToggleProps) {
  const { look, scheme } = useAppearance();
  // Legacy modes (system/light/dark) show as the look they resolve to.
  const value: ThemeMode = look === 'harbour' ? (scheme === 'dark' ? 'harbour-night' : 'harbour') : look;

  const onChange = useCallback((next: ThemeMode) => {
    // Fire-and-forget: the mode applies synchronously, only the write is async.
    void persistThemeMode(next);
  }, []);

  return (
    <SegmentedControl
      options={OPTIONS}
      value={value}
      onChange={onChange}
      accessibilityLabel="Appearance"
      role="radio"
      testID={testID}
      style={style}
    />
  );
}
