// Scan the pairing QR the host prints at startup.
//
// This removes both typing steps — the address and the six digits — which are
// the clunkiest part of setup. The manual path stays available for a terminal
// that mangles the QR, a remote SSH session, or a camera permission the user
// would rather not grant.

import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { Banner, Button, Caption, Heading, MachinePanel, Txt } from '../ui';
import { useTheme } from '../theme';
import { parsePairLink } from './pair-link';
import type { ParsedPairLink } from './pair-link';

export interface ScanStepProps<T = ParsedPairLink> {
  onScanned: (link: T) => void;
  onCancel: () => void;
  /** What a QR must decode to. Defaults to the pairing link; the account's claim link is the other. */
  parse?: (raw: string) => T | null;
  heading?: string;
  cancelLabel?: string;
}

export function ScanStep<T = ParsedPairLink>({
  onScanned, onCancel, parse = parsePairLink as unknown as (raw: string) => T | null,
  heading = 'Scan to connect', cancelLabel = 'Connect by address instead',
}: ScanStepProps<T>) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [sawUnknownCode, setSawUnknownCode] = useState(false);

  /**
   * The camera fires this many times a second while a code is in frame, so the
   * first successful parse has to latch — without this the pairing request is
   * sent repeatedly, and since a pairing code is single-use every attempt after
   * the first fails and the user sees an error on a scan that actually worked.
   */
  const handled = useRef(false);

  const onBarcode = useCallback((result: { data: string }) => {
    if (handled.current) return;

    const link = parse(result.data);
    if (!link) {
      // Some other QR drifted through frame. Say so once rather than flashing
      // an error on every frame, and keep scanning.
      setSawUnknownCode(true);
      return;
    }

    // Valid code found - clear any previous unknown-code banner and latch
    setSawUnknownCode(false);
    handled.current = true;
    onScanned(link);
  }, [onScanned, parse]);

  if (!permission) {
    // Still reading the current permission state.
    return <Caption>Checking camera access…</Caption>;
  }

  if (!permission.granted) {
    return (
      <View style={{ gap: theme.space.md }}>
        <Heading>{heading}</Heading>
        <Txt>
          Belay needs the camera to read the QR code shown on your computer.
          It is only used while this screen is open.
        </Txt>
        {/* Stacked: a long cancel label ("Connect by address instead")
            beside the pill squeezed "Allow camera" to "Allow c…". */}
        <View style={{ gap: theme.space.xs }}>
          <Button
            label={permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
            fullWidth
            onPress={() => void requestPermission()}
          />
          <Button label={cancelLabel} variant="ghost" fullWidth onPress={onCancel} />
        </View>
        {!permission.canAskAgain ? (
          <Caption>
            Camera access was declined before, so it has to be re-enabled in iOS
            Settings under Belay.
          </Caption>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space.md }}>
      <View style={{ gap: theme.space.xs }}>
        <Heading>{heading}</Heading>
        <Caption>Point the camera at the QR code Belay shows on your computer.</Caption>
      </View>

      {/* The viewfinder is a window into the camera the way the terminal is a
          window into the computer, so it sits on the same machine panel:
          true-dark, square, hairline-separated, full-bleed. */}
      <MachinePanel testID="scan-viewfinder" bleed={theme.layout.margin}>
        <CameraView
          style={{ aspectRatio: 1, width: '100%' }}
          facing="back"
          // Only QR is requested: narrowing the formats keeps the scanner from
          // latching onto barcodes on whatever else is on the desk.
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onBarcode}
        />
      </MachinePanel>

      {sawUnknownCode ? (
        <Banner
          status="warn"
          title="That code is not a Belay code"
          message="Open Belay on your computer — it shows the code to scan."
        />
      ) : null}

      <Button label={cancelLabel} variant="ghost" fullWidth onPress={onCancel} />
    </View>
  );
}
