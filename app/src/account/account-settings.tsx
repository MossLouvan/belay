// The account rows in the computers list's Options sheet, and the Delete
// Account confirmation. Deleting is DELETE /me — the account, its devices and
// sessions go on the server (App Store 5.1.1(v)) — then every local trace.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { Button, Caption, Label, Row, Rule, Sheet, Txt, haptic } from '../ui';
import { useTheme } from '../theme';
import { errorMessage } from '../connect/pair-flow';
import { useConnection } from '../connection';
import { useAccount } from './store';
import { isTunnelAvailable } from '../../modules/belay-stream/src/tunnel';

export interface AccountRowsProps {
  /** Closes the sheet these rows live in, before another sheet or screen opens. */
  readonly onLeave: () => void;
  readonly onRequestDelete: () => void;
}

/** Who is signed in, with Sign out and Delete account — or Sign in when nobody is. */
export function AccountRows({ onLeave, onRequestDelete }: AccountRowsProps) {
  const theme = useTheme();
  const { account, signOut } = useAccount();

  const onSignOut = useCallback(async () => {
    haptic('light');
    await signOut();
    onLeave();
    // The front door's gate decides what is next: sign in again with no
    // computers paired here, the list when there are (account/gate.ts).
    router.replace('/');
  }, [signOut, onLeave]);

  if (!account) {
    return (
      <View style={{ gap: theme.space.sm }}>
        <Label>Account</Label>
        <Rule />
        <Caption>{isTunnelAvailable() ? 'Sign in to link computers and reach them from anywhere.' : 'Sign in to link your computers.'}</Caption>
        <Button label="Sign in" testID="options-sign-in" fullWidth onPress={() => { onLeave(); router.push('/sign-in?next=/devices'); }} />
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space.sm }}>
      <Label>Account</Label>
      <Rule />
      <Txt variant="mono" testID="account-email">{account.email ?? 'Signed in'}</Txt>
      <Row gap="sm">
        <View style={{ flex: 1 }}>
          <Button label="Sign out" testID="sign-out" variant="secondary" fullWidth onPress={() => void onSignOut()} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Delete account" testID="delete-account" variant="ghost" fullWidth onPress={() => { onLeave(); onRequestDelete(); }} />
        </View>
      </Row>
    </View>
  );
}

export interface DeleteAccountSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
}

export function DeleteAccountSheet({ visible, onClose }: DeleteAccountSheetProps) {
  const theme = useTheme();
  const { deleteAccount } = useAccount();
  const { disconnect } = useConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      // The pairings are keyed to computers that are no longer on any
      // account; a deleted account should leave no computer behind on the phone.
      await disconnect();
      haptic('success');
      onClose();
      router.replace('/');
    } catch (e: unknown) {
      haptic('error');
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [deleteAccount, disconnect, onClose]);

  return (
    <Sheet visible={visible} onClose={onClose} title="Delete your account?" testID="delete-account-sheet">
      <View style={{ gap: theme.space.md }}>
        <Txt>
          This removes your account, every computer linked to it, and signs out every phone.
          Pairings on this phone are forgotten too. It cannot be undone.
        </Txt>
        {error ? <Txt variant="caption" tone="bad" testID="delete-account-error">{error}</Txt> : null}
        <Row gap="sm">
          <View style={{ flex: 1 }}>
            <Button label="Cancel" variant="secondary" fullWidth disabled={busy} onPress={onClose} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Delete" testID="confirm-delete-account" variant="danger" fullWidth loading={busy} onPress={() => void onConfirm()} />
          </View>
        </Row>
      </View>
    </Sheet>
  );
}
