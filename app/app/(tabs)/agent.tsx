// Agent tab — drive Claude Code sessions on the PC from anywhere. The list and
// the open-session screen live in `src/agent/`; expo-router would turn a
// helper module under `app/` into an extra tab.

import React, { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { useTheme } from '../../src/theme';
import { SessionList } from '../../src/agent/session-list';
import { SessionView } from '../../src/agent/session-view';

export default function AgentTab() {
  const { connection } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
      {!connection ? null : openId ? (
        <SessionView id={openId} onBack={() => setOpenId(null)} />
      ) : (
        <SessionList onOpen={setOpenId} />
      )}
      <View style={{ height: theme.space.sm }} />
    </View>
  );
}
