// The one notice for "iOS Local Network permission is off": the fix is in
// Settings, so the button goes there, and Retry re-runs whatever failed.

import React from 'react';
import { Linking } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Banner, haptic } from '../ui';
import { LOCAL_NETWORK_MESSAGE, LOCAL_NETWORK_TITLE } from './local-network';

export function LocalNetworkNotice({ onRetry, style }: { onRetry: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <Banner
      testID="local-network-banner"
      status="bad"
      title={LOCAL_NETWORK_TITLE}
      message={LOCAL_NETWORK_MESSAGE}
      action={{
        label: 'Open Settings',
        onPress: () => {
          haptic('light');
          Linking.openSettings().catch((e: unknown) => console.warn('openSettings failed', e));
        },
      }}
      secondaryAction={{ label: 'Retry', onPress: onRetry }}
      style={style}
    />
  );
}
