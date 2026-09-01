// Scan the pairing QR the host prints at startup.
//
// This removes both typing steps — the address and the six digits — which are
// the clunkiest part of setup. The manual path stays available for a terminal
// that mangles the QR, a remote SSH session, or a camera permission the user
// would rather not grant.

import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { Banner, Button, Caption, Heading, MachinePanel, Row, Txt } from '../ui';
import { useTheme } from '../theme';
import { parsePairLink } from './pair-link';
import type { ParsedPairLink } from './pair-link';

export interface ScanStepProps {
  onScanned: (link: ParsedPairLink) => void;
  onCancel: () => void;
}

export function ScanStep({ onScanned, onCancel }: ScanStepProps) {
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

    const link = parsePairLink(result.data);
    if (!link) {
      // Some other QR drifted through frame. Say so once rather than flashing
      // an error on every frame, and keep scanning.
      setSawUnknownCode(true);
      return;
    }

    handled.current = true;
    onScanned(link);
  }, [onScanned]);

  if (!permission) {
    // Still reading the current permission state.
    return <Caption>Checking camera access…</Caption>;
  }

  if (!permission.granted) {
    return (
      <View style={{ gap: theme.space.md }}>
        <Heading>Scan to connect</Heading>
        <Txt>
          Belay needs the camera to read the pairing code shown on your computer.
          It is only used while this screen is open.
        </Txt>
        <Row gap="sm">
          <View style={{ flex: 1 }}>
            <Button
              label={permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
              fullWidth
              onPress={() => void requestPermission()}
            />
          </View>
          <Button label="Type it instead" variant="ghost" onPress={onCancel} />
        </Row>
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
        <Heading>Scan to connect</Heading>
        <Caption>Point the camera at the code shown in your computer's terminal.</Caption>
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
          message="Start the host agent on your computer — it prints the code to scan."
        />
      ) : null}

      <Button label="Type it in instead" variant="ghost" fullWidth onPress={onCancel} />
    </View>
  );
}
