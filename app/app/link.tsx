// "Scan to link a computer": read the claim QR the host shows when it starts
// unlinked (or type the 8-character code printed beside it), accept the claim
// on the account, and land back on the list with the computer linked. Needs a
// session (the gate sends anyone else to sign in).

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { Banner, Button, Caption, Heading, Input, Screen, haptic } from '../src/ui';
import { useTheme } from '../src/theme';
import { ScanStep } from '../src/connect/scan';
import { errorMessage } from '../src/connect/pair-flow';
import { AccountsError } from '../src/account/api';
import { parseClaimCode, parseClaimLink } from '../src/account/claim-link';
import type { ParsedClaimLink } from '../src/account/claim-link';
import { useAccount } from '../src/account/store';
import { startPairingOverTunnel } from '../src/account/pair-over-tunnel';

export default function Link() {
  const theme = useTheme();
  const { api, refreshDevices, ready, account } = useAccount();
  // Linking is an account action: a signed-out deep link signs in first.
  useEffect(() => {
    if (ready && !account) router.replace('/sign-in?next=/link');
  }, [ready, account]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A 409: the account already has this computer; the fix is on the list. */
  const [alreadyLinked, setAlreadyLinked] = useState(false);
  const [scanKey, setScanKey] = useState(0);

  const [typed, setTyped] = useState('');

  /** Accept a claim. A scanned QR names its node, and the server must agree. */
  const link = useCallback(async (code: string, scannedNodeId: string | null) => {
    setBusy(true);
    setError(null);
    setAlreadyLinked(false);
    try {
      // The nodeId in the QR is the one the phone will later dial; the server
      // says which node the code belongs to. They must agree, or this phone
      // would tunnel to a computer the QR never named. A typed code has no
      // QR to disagree with, so the server's answer is the node.
      const device = await api.acceptClaim(code);
      if (scannedNodeId !== null && device.nodeId !== scannedNodeId) throw new Error('That code belongs to a different computer than the one shown. Scan it again.');
      await refreshDevices();
      haptic('success');
      // Linked; now pair through the tunnel with the code the host shows next.
      // If the tunnel cannot reach it yet (the host admits this phone on its
      // next heartbeat, up to a minute), the list offers Pair again.
      router.replace('/devices');
      await startPairingOverTunnel(device.nodeId);
    } catch (e: unknown) {
      haptic('error');
      setError(errorMessage(e));
      setAlreadyLinked(e instanceof AccountsError && e.code === 'already_linked');
      setScanKey((k) => k + 1); // a fresh scanner, since the last one latched
    } finally {
      setBusy(false);
    }
  }, [api, refreshDevices]);

  const onScanned = useCallback((scanned: ParsedClaimLink) => link(scanned.code, scanned.nodeId), [link]);

  const onTyped = useCallback(() => {
    const code = parseClaimCode(typed);
    if (!code) { setError('Type the 8 letters and numbers shown under the QR code on your computer.'); return; }
    void link(code, null);
  }, [typed, link]);

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
          <>
            <Caption>
              Open Belay on your computer. Until it is linked, it shows a QR code to scan here.
            </Caption>
            <Input
              label="Or type the code" testID="claim-code-field" value={typed} onChangeText={setTyped}
              placeholder="ABCD2345" mono autoCapitalize="characters" autoCorrect={false}
              returnKeyType="go" onSubmitEditing={onTyped}
              helper="The 8 letters and numbers under the QR code on your computer."
            />
            <Button label="Link computer" testID="claim-code-submit" variant="secondary" fullWidth onPress={onTyped} />
          </>
        ) : null}
        {busy ? <Button label="Cancel" variant="ghost" fullWidth onPress={() => router.back()} /> : null}
      </View>
    </Screen>
  );
}
