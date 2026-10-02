// "Add a computer" from the computer list. The way in is the claim QR Belay
// shows on an unlinked computer (app/link.tsx). Connecting by address is the
// advanced door, folded away: the same address field as the connect screen,
// not a copy of it.
//
// The list owns no pairing state, so the field here only collects the text;
// Connect hands it to the connect screen (`/?add=1&address=…`), which checks
// it on arrival exactly as if it had been typed there. "Scan a code instead"
// lands on the same screen with its scanner up.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '../theme';
import { Button, Caption, Label, Rule, TrackLabel } from '../ui';
import { useAccount } from '../account/store';
import { AddressEntry } from '../connect/address-entry';
import { addComputerRoute } from './add-computer-route';

interface AddComputerProps {
  /** Rendered above the field; omitted on the empty state, which has its own heading. */
  readonly heading?: boolean;
  readonly testID?: string;
  /**
   * Called just before leaving for the connect screen. The sheet that hosts
   * this closes itself here — on web the list stays mounted under the pushed
   * route, so an open sheet would sit over the pairing form (#82).
   */
  readonly onNavigate?: () => void;
}

export function AddComputer({ heading = true, testID = 'add-computer', onNavigate }: AddComputerProps) {
  const theme = useTheme();
  const { account } = useAccount();
  const [address, setAddress] = useState('');
  const [advanced, setAdvanced] = useState(false);

  /** The claim QR an unlinked host shows. Signed out, sign in first and come back here. */
  const onLink = useCallback(() => {
    onNavigate?.();
    router.push(account ? '/link' : '/sign-in?next=/link');
  }, [account, onNavigate]);

  const onSubmit = useCallback(() => {
    const route = addComputerRoute(address);
    if (!route) return;
    onNavigate?.();
    router.push(route);
  }, [address, onNavigate]);

  const onScan = useCallback(() => {
    const route = addComputerRoute(null);
    if (!route) return;
    onNavigate?.();
    router.push(route);
  }, [onNavigate]);

  return (
    <View testID={testID} style={{ gap: theme.space.md }}>
      {heading ? (
        <View>
          <Label>Add a computer</Label>
          <Rule bleed={theme.layout.margin} />
        </View>
      ) : null}
      <Caption>Open Belay on the computer. It shows a QR code (and a code to type) until it is linked.</Caption>
      <Button
        label="Scan to link a computer"
        testID="scan-to-link"
        fullWidth
        accessibilityHint="Reads the QR code Belay shows on an unlinked computer and adds it to your account"
        onPress={onLink}
      />
      <TrackLabel
        label="Advanced: connect by address"
        active={advanced}
        onPress={() => setAdvanced((open) => !open)}
        testID="add-advanced"
      />
      {advanced ? (
        <AddressEntry
          value={address}
          onChangeText={setAddress}
          onSubmit={onSubmit}
          busy={false}
          onScan={onScan}
        />
      ) : null}
    </View>
  );
}
