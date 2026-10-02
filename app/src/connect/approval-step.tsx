// Account trust's one waiting screen: this phone asked a computer on its
// account to let it in, and the owner taps Allow on Belay.app or on a phone
// already paired with it (account/account-pair.ts). Cancel withdraws it.

import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '../theme';
import { Banner, Button, Caption, Heading } from '../ui';
import type { Diagnosis } from './diagnose';

export interface ApprovalStepProps {
  readonly hostName: string;
  readonly error: Diagnosis | null;
  readonly busy: boolean;
  readonly onAskAgain: () => void;
  readonly onCancel: () => void;
}

export function ApprovalStep({ hostName, error, busy, onAskAgain, onCancel }: ApprovalStepProps) {
  const theme = useTheme();
  if (error) {
    return (
      <View testID="approval-error" style={{ gap: theme.space.md }}>
        <Banner status="bad" title={error.title} message={error.message} />
        <Button testID="approval-retry" label="Ask again" fullWidth loading={busy} onPress={onAskAgain} />
        <Button label="Cancel" variant="ghost" fullWidth onPress={() => router.back()} />
      </View>
    );
  }
  return (
    <View testID="approval-waiting" accessibilityLiveRegion="polite" style={{ gap: theme.space.md }}>
      <Heading>Waiting for approval on your computer or another phone…</Heading>
      <Caption>
        {`Tap Allow in Belay on ${hostName}, or on a phone that already uses it. Nothing to type.`}
      </Caption>
      <ActivityIndicator color={theme.colors.textDim} />
      <Button testID="approval-cancel" label="Cancel" variant="ghost" fullWidth onPress={onCancel} />
    </View>
  );
}
