// Privacy policy + support rows. App Store guideline 5.1.1(i) wants the
// privacy policy reachable from inside the app, not only from the listing.

import React from 'react';
import { Linking, View } from 'react-native';
import { ListItem } from '../ui';

export const PRIVACY_URL = 'https://gobelay.com/privacy';
export const SUPPORT_URL = 'https://gobelay.com/support';

/** Two tappable rows that open the public privacy and support pages. */
export function SupportLinks({ testID }: { testID?: string }) {
  return (
    <View testID={testID}>
      <ListItem
        title="Privacy policy"
        subtitle="gobelay.com/privacy"
        accessibilityHint="Opens the privacy policy in your browser"
        testID="privacy-policy-link"
        onPress={() => void Linking.openURL(PRIVACY_URL).catch(() => undefined)}
      />
      <ListItem
        title="Support"
        subtitle="gobelay.com/support"
        accessibilityHint="Opens the support page in your browser"
        testID="support-link"
        onPress={() => void Linking.openURL(SUPPORT_URL).catch(() => undefined)}
      />
    </View>
  );
}
