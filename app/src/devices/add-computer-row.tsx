// The "Add computer" row that closes the list in both mockups.
//
// Current draws it as another card in the stack — a rounded-square `+` well,
// the label, a trailing chevron — so it reads as "one more computer, the one
// you have not added yet". Fieldwork drops the chevron and centres a large
// bare `+` with the label beside it, and stands a good deal taller. Same
// control, two drawings.

import React from 'react';
import { Pressable, View } from 'react-native';
import { IconChevronRight, IconPlus } from '@tabler/icons-react-native';
import { Txt } from '../ui';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';

export interface AddComputerRowProps {
  readonly onPress: () => void;
  readonly testID?: string;
}

export function AddComputerRow({ onPress, testID = 'show-add-computer' }: AddComputerRowProps) {
  const theme = useTheme();
  const look = useLook();
  const centred = look.deviceThumbWide; // Fieldwork

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Add computer"
      accessibilityHint="Pairs this phone with another Mac or Windows PC"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: theme.colors.surface,
        borderRadius: look.cardRadius,
        borderWidth: look.cardBorder ? theme.layout.hairline : 0,
        borderColor: theme.colors.border,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: centred ? 'center' : 'flex-start',
        gap: centred ? 20 : 14,
        paddingHorizontal: centred ? 20 : 12,
        minHeight: centred ? 96 : 64,
        opacity: pressed ? theme.motion.pressOpacity : 1,
      })}
    >
      {centred ? (
        <IconPlus size={28} strokeWidth={2} color={theme.colors.text} />
      ) : (
        <View
          style={{
            width: 40, height: 40, borderRadius: 10,
            backgroundColor: theme.colors.surfaceAlt,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <IconPlus size={20} strokeWidth={2.2} color={theme.colors.textDim} />
        </View>
      )}
      <Txt variant="subheading" style={centred ? undefined : { flex: 1 }}>Add computer</Txt>
      {centred ? null : <IconChevronRight size={20} strokeWidth={2} color={theme.colors.textFaint} />}
    </Pressable>
  );
}
