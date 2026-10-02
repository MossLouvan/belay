// The computers list with nothing in it.
//
// Neither mockup draws this state, so it is built from their rules rather than
// copied: same masthead, same page title, and where the card stack would be, a
// single quiet panel that says what to do and one button that does it. The
// pairing form is not inlined here — it is the same sheet the populated list
// opens, so there is exactly one place in the app where a computer gets added.

import React from 'react';
import { View } from 'react-native';
import { Screen, Txt } from '../ui';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { DevicesHeader } from './devices-header';
import { AddComputerRow } from './add-computer-row';

export interface EmptyComputersProps {
  readonly onAdd: () => void;
  readonly onOpenOptions: () => void;
}

export function EmptyComputers({ onAdd, onOpenOptions }: EmptyComputersProps) {
  const theme = useTheme();
  const look = useLook();

  return (
    <Screen scroll padding="page">
      <View style={{ gap: theme.space.lg }}>
        <DevicesHeader onAdd={onAdd} onOpenOptions={onOpenOptions} />
        <View>
          <Txt variant="display" heading>{look.devicesTitle}</Txt>
          <Txt variant="body" tone="dim" style={{ marginTop: 2 }}>No computers yet</Txt>
        </View>
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: look.cardRadius,
            // Harbour's soft depth; 'none' on the flat looks.
            boxShadow: theme.colors.depth === 'none' ? undefined : theme.colors.depth,
            borderWidth: look.cardBorder ? theme.layout.hairline : 0,
            borderColor: theme.colors.border,
            padding: theme.space.md,
            gap: theme.space.xs,
          }}
        >
          <Txt variant="subheading">Put Belay on your computer</Txt>
          <Txt variant="body" tone="dim">
            Get it at gobelay.com and open it, then tap Add computer and scan the QR code it
            shows. The phone remembers it after that.
          </Txt>
        </View>
        <AddComputerRow onPress={onAdd} testID="add-a-computer" />
      </View>
    </Screen>
  );
}
