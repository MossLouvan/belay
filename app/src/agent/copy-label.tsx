// The transcript's Copy control: a TrackLabel that lifts a whole message or
// output block onto the clipboard, flashing ✓/✗ in the same mark that
// announced it — the exact idiom the Files path bar already speaks
// (docs/DESIGN.md §11.1), so "Copy" reads identically across tabs.
//
// The clipboard call rides the files tab's never-throws wrapper; a refused
// clipboard (web without a secure context, a managed device) becomes the ✗
// flash, never a crash or a silent nothing.

import React, { useEffect, useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { TrackLabel } from '../ui';
import { copyText } from '../files/clipboard';
import { COPY_FLASH_MS, copyLabel } from './copy-model';
import type { CopyFlash } from './copy-model';

export interface CopyLabelProps {
  /** The whole block this control copies. */
  text: string;
  /** What the block is, for screen readers — e.g. "Copy this prompt". */
  accessibilityLabel: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function CopyLabel({ text, accessibilityLabel, testID, style }: CopyLabelProps) {
  const theme = useTheme();
  const [flash, setFlash] = useState<CopyFlash>('idle');

  // The flash must not outlive the component — a timer firing into an
  // unmounted setState is exactly the warning React nags about.
  useEffect(() => {
    if (flash === 'idle') return;
    const timer = setTimeout(() => setFlash('idle'), COPY_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const flashColor =
    flash === 'copied' ? theme.colors.good : flash === 'failed' ? theme.colors.bad : undefined;

  return (
    <TrackLabel
      testID={testID}
      label={copyLabel(flash)}
      accessibilityLabel={flash === 'copied' ? 'Copied' : accessibilityLabel}
      onPress={() => {
        void copyText(text).then((ok) => setFlash(ok ? 'copied' : 'failed'));
      }}
      hitSlop={theme.layout.hitSlop}
      labelColor={flashColor}
      trackColor={flashColor}
      style={style}
    />
  );
}
