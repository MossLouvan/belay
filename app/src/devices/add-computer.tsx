// "Add a computer" from the computer list: the same address field as the
// connect screen, not a copy of it.
//
// The list owns no pairing state, so the field here only collects the text;
// Connect hands it to the connect screen (`/?add=1&address=…`), which checks
// it on arrival exactly as if it had been typed there. "Scan a code instead"
// lands on the same screen with its scanner up.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '../theme';
import { Label, Rule } from '../ui';
import { AddressEntry } from '../connect/address-entry';
import { addComputerRoute } from './add-computer-route';

interface AddComputerProps {
  /** Rendered above the field; omitted on the empty state, which has its own heading. */
  readonly heading?: boolean;
  readonly testID?: string;
}

export function AddComputer({ heading = true, testID = 'add-computer' }: AddComputerProps) {
  const theme = useTheme();
  const [address, setAddress] = useState('');

  const onSubmit = useCallback(() => {
    const route = addComputerRoute(address);
    if (route) router.push(route);
  }, [address]);

  const onScan = useCallback(() => {
    const route = addComputerRoute(null);
    if (route) router.push(route);
  }, []);

  return (
    <View testID={testID} style={{ gap: theme.space.md }}>
      {heading ? (
        <View>
          <Label>Add a computer</Label>
          <Rule bleed={theme.layout.margin} />
        </View>
      ) : null}
      <AddressEntry
        value={address}
        onChangeText={setAddress}
        onSubmit={onSubmit}
        busy={false}
        onScan={onScan}
      />
    </View>
  );
}
