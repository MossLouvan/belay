// Agent tab — drive Claude Code sessions on the PC from anywhere. The list and
// the open-session screen live in `src/agent/`; expo-router would turn a
// helper module under `app/` into an extra tab.

import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { useTheme } from '../../src/theme';
import { Card, ConnectionStatus, EmptyState, Rule, Txt } from '../../src/ui';
import { setOpenSession, useAgentAttention } from '../../src/agent/attention-store';
import { SessionList } from '../../src/agent/session-list';
import { SessionView } from '../../src/agent/session-view';
import { ToolPanel } from '../../src/home/panel';

/**
 * What the tab shows before there is a live link. The old code rendered a bare
 * `null` here — a blank rectangle that gave a first-time user nothing to do and
 * looked broken (docs/FRONTEND-REVAMP.md §4.2, the highest-impact fix). Now the
 * tab is honest about the state: while the app is racing the computer's
 * addresses it says so and pulses; otherwise it names the one way forward —
 * pick a computer to run agents on.
 */
function NotConnected() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { phase, active } = useConnection();
  const margin = theme.layout.margin;
  const connecting = phase === 'connecting';

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top + theme.space.md }}>
      <View style={{ paddingHorizontal: margin }}>
        <Txt variant="title" heading>Agent</Txt>
        <ConnectionStatus
          testID="agent-connection"
          phase={phase}
          machine={active?.label}
          style={{ marginTop: theme.space.xxs }}
        />
      </View>
      <Rule style={{ marginTop: theme.space.md }} />
      {/* The empty tab's one message sits in a bordered card, like every
          other grouped surface after the Next Terminal sweep. */}
      <Card style={{ marginHorizontal: margin, marginTop: theme.space.lg }}>
        {connecting ? (
          <EmptyState
            testID="agent-connecting"
            title="Reaching the computer"
            message={
              active
                ? `Waking a link to ${active.label}. This tab will fill in as soon as it answers.`
                : 'Waking a link to the computer. This tab will fill in as soon as it answers.'
            }
          />
        ) : (
          <EmptyState
            testID="agent-not-connected"
            title="Not connected"
            message="Agents run on one of your computers. Pick a computer to connect, then start a session here."
            action={{ label: 'Pick a computer', onPress: () => router.navigate('/devices') }}
          />
        )}
      </Card>
    </View>
  );
}

/** The panel route: the unchanged tab body inside the shared slide-up chrome. */
export default function AgentPanel() {
  return (
    <ToolPanel testID="agent-panel">
      <AgentTab />
    </ToolPanel>
  );
}

function AgentTab() {
  const { connection } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Which session is open lives in the attention store, not local state, so
  // the cross-tab "needs you" banner can jump straight into the session that
  // is asking — and stand down once it is on screen.
  const { openId } = useAgentAttention();
  const setOpenId = setOpenSession;

  if (!connection) return <NotConnected />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
      {openId ? (
        <SessionView id={openId} onBack={() => setOpenId(null)} />
      ) : (
        <SessionList onOpen={setOpenId} />
      )}
      <View style={{ height: theme.space.sm }} />
    </View>
  );
}
