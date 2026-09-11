// The picture of a computer on its row in the list.
//
// HONESTY NOTE. Both concept mockups draw this tile differently and one of
// them cannot be built as drawn: Fieldwork shows each card carrying a live
// wallpaper photo of that machine's desktop. The host agent exposes no
// still-frame endpoint — pictures only exist inside an open stream session, and
// the list is precisely the screen where no session is open — so for an
// offline or never-connected computer there is no real frame to show and
// nothing here is going to invent one.
//
// What it shows instead is a deliberate empty state in the same silhouette: a
// recessed 16:10 tile (Fieldwork) or square (Current) carrying the machine's
// own glyph — a monitor for a desktop, a laptop for a laptop — at the weight
// the rest of the app draws icons. Offline computers dim the whole tile rather
// than swapping in a different drawing, so "off" is one visual rule everywhere.

import React from 'react';
import { View } from 'react-native';
import { IconDeviceDesktop, IconDeviceLaptop } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import type { SavedDevice } from './model';

/** Laptops get the clamshell; everything else gets the monitor. */
export function isLaptop(device: Pick<SavedDevice, 'platform'>): boolean {
  return device.platform === 'darwin';
}

export interface DeviceThumbProps {
  readonly device: Pick<SavedDevice, 'platform'>;
  /** Dims the tile: the computer is asleep, off, or unreachable. */
  readonly dim?: boolean;
}

/**
 * The leading tile on a device row. Sized by the appearance — Fieldwork's wide
 * preview tile, Current's square glyph well — and never taller than the row it
 * leads.
 */
export function DeviceThumb({ device, dim = false }: DeviceThumbProps) {
  const theme = useTheme();
  const look = useLook();
  const Glyph = isLaptop(device) ? IconDeviceLaptop : IconDeviceDesktop;
  const wide = look.deviceThumbWide;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: wide ? 112 : 58,
        height: wide ? 70 : 58,
        borderRadius: wide ? 8 : 10,
        backgroundColor: wide ? theme.colors.surfaceAlt : 'transparent',
        borderWidth: wide ? theme.layout.hairline : 0,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: dim ? 0.45 : 1,
      }}
    >
      <Glyph size={wide ? 36 : 44} strokeWidth={1.6} color={theme.colors.textDim} />
    </View>
  );
}
