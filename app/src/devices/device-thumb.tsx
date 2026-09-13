// The picture of a computer on its row in the list.
//
// Both concept mockups draw this tile as a thumbnail of that machine's actual
// desktop, and until recently that could not be built: a frame of the host's
// screen only existed inside an open /ws/screen session, and the list is
// precisely the screen where none is open. The host now answers
// GET /screen/thumbnail with one small still (server/src/thumbnail.ts), and the
// phone keeps the last frame it saw while streaming (src/home/preview-store),
// so the tile draws a real desktop whenever one is known.
//
// What it draws, in order:
//   1. The desktop, when a preview exists for this computer — the last frame
//      you were looking at, or a still fetched from the machine itself.
//   2. Otherwise the empty state, unchanged: the same recessed tile carrying
//      the machine's own glyph — a monitor for a desktop, a laptop for a
//      laptop. This is the honest drawing for "no picture exists", not a
//      spinner pretending one is on the way: a computer that is off, or that
//      this phone has never opened, may never have one.
//
// Offline dims the whole tile either way — including a real desktop, which
// when dimmed reads as "this is what it looked like", not "this is live". Off
// stays one visual rule everywhere.

import React from 'react';
import { Image, View } from 'react-native';
import { IconDeviceDesktop, IconDeviceLaptop } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { useDevicePreview } from '../home/preview-store';
import type { SavedDevice } from './model';

/** Laptops get the clamshell; everything else gets the monitor. */
export function isLaptop(device: Pick<SavedDevice, 'platform'>): boolean {
  return device.platform === 'darwin';
}

export interface DeviceThumbProps {
  readonly device: Pick<SavedDevice, 'id' | 'platform'>;
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
  const preview = useDevicePreview(device.id);
  const Glyph = isLaptop(device) ? IconDeviceLaptop : IconDeviceDesktop;
  const wide = look.deviceThumbWide;
  // 8pt in Fieldwork, 10pt in Current — which is exactly `controlRadius`.
  const radius = look.controlRadius;

  return (
    <View
      testID={`computer-thumb-${device.id}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: wide ? 112 : 58,
        height: wide ? 70 : 58,
        borderRadius: radius,
        // A real desktop gets the recessed well in BOTH appearances: a picture
        // needs an edge to sit in, where a line glyph does not.
        backgroundColor: wide || preview ? theme.colors.surfaceAlt : 'transparent',
        borderWidth: wide || preview ? theme.layout.hairline : 0,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        opacity: dim ? 0.45 : 1,
      }}
    >
      {preview ? (
        <Image
          testID={`computer-preview-${device.id}`}
          source={{ uri: preview.uri }}
          // `cover` rather than `contain`: a 16:10 desktop in a 16:10 tile is
          // an exact fit, and the square Current tile should read as a crop of
          // the desktop rather than a letterboxed postage stamp.
          resizeMode="cover"
          style={{ width: '100%', height: '100%', borderRadius: radius }}
        />
      ) : (
        <Glyph size={wide ? 36 : 44} strokeWidth={1.6} color={theme.colors.textDim} />
      )}
    </View>
  );
}
