// "Scan to link a computer": read the claim QR the host shows when it starts
// unlinked, accept the claim on the account, and land back on the list with
// the computer linked. Needs a session (the gate sends anyone else to sign in).

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { Banner, Button, Caption, Heading, Screen, haptic } from '../src/ui';
import { useTheme } from '../src/theme';
import { ScanStep } from '../src/connect/scan';
import { errorMessage } from '../src/connect/pair-flow';
import { AccountsError } from '../src/account/api';
import { parseClaimLink } from '../src/account/claim-link';
import type { ParsedClaimLink } from '../src/account/claim-link';
import { useAccount } from '../src/account/store';

export default function Link() {
  const theme = useTheme();
  const { api, refreshDevices } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A 409: the account already has this computer; the fix is on the list. */
  const [alreadyLinked, setAlreadyLinked] = useState(false);
  const [scanKey, setScanKey] = useState(0);

  const onScanned = useCallback(async (link: ParsedClaimLink) => {
    setBusy(true);
    setError(null);
    setAlreadyLinked(false);
    try {
      // The nodeId in the QR is the one the phone will later dial; the server
      // says which node the code belongs to. They must agree, or this phone
      // would tunnel to a computer the QR never named.
      const device = await api.acceptClaim(link.code);
      if (device.nodeId !== link.nodeId) throw new Error('That code belongs to a different computer than the one shown. Scan it again.');
      await refreshDevices();
      haptic('success');
      router.replace('/devices');
    } catch (e: unknown) {
      haptic('error');
      setError(errorMessage(e));
      setAlreadyLinked(e instanceof AccountsError && e.code === 'already_linked');
      setScanKey((k) => k + 1); // a fresh scanner, since the last one latched
    } finally {
      setBusy(false);
    }
  }, [api, refreshDevices]);

  return (
    <Screen scroll padding="page">
      <View style={{ gap: theme.space.md }}>
        {busy ? (
          <View style={{ gap: theme.space.xs }}>
            <Heading>Linking…</Heading>
            <Caption>Adding this computer to your account.</Caption>
          </View>
        ) : (
          <ScanStep
            key={scanKey}
            parse={parseClaimLink}
            heading="Scan to link a computer"
            cancelLabel="Cancel"
            onScanned={(link) => void onScanned(link)}
            onCancel={() => router.back()}
          />
        )}
        {error ? (
          <Banner
            status="bad" title="Could not link" message={error} testID="link-error"
            action={alreadyLinked ? { label: 'Show linked computers', onPress: () => router.replace('/devices') } : undefined}
          />
        ) : null}
        {!busy ? (
          <Caption>
            Start Belay on the computer. Until it is linked, it shows a QR code to scan here.
          </Caption>
        ) : null}
        {busy ? <Button label="Cancel" variant="ghost" fullWidth onPress={() => router.back()} /> : null}
      </View>
    </Screen>
  );
}
